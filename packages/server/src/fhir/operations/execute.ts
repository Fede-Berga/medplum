import {
  allOk,
  badRequest,
  ContentType,
  createReference,
  getStatus,
  Hl7Message,
  isOk,
  isOperationOutcome,
  isResource,
  MedplumClient,
  normalizeErrorString,
  normalizeOperationOutcome,
  OperationOutcomeError,
  Operator,
  resolveId,
  serverError,
  WithId,
} from '@medplum/core';
import { FhirRequest } from '@medplum/fhir-router';
import {
  Agent,
  AuditEvent,
  Binary,
  Bot,
  Device,
  Login,
  OperationOutcome,
  Organization,
  Parameters,
  Project,
  ProjectMembership,
  ProjectSetting,
  Reference,
  Subscription,
} from '@medplum/fhirtypes';
import { Request, Response } from 'express';
import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { asyncWrap } from '../../async';
import { runInLambda } from '../../cloud/aws/execute';
import { getConfig } from '../../config/loader';
import { AuthenticatedRequestContext, buildTracingExtension, getAuthenticatedContext } from '../../context';
import { getLogger } from '../../logger';
import { generateAccessToken } from '../../oauth/keys';
import { recordHistogramValue } from '../../otel/otel';
import { getBinaryStorage } from '../../storage/loader';
import { AuditEventOutcome, logAuditEvent } from '../../util/auditevent';
import { MockConsole } from '../../util/console';
import { readStreamToString } from '../../util/streams';
import { createAuditEventEntities, findProjectMembership } from '../../workers/utils';
import { sendOutcome } from '../outcomes';
import { getSystemRepo, Repository } from '../repo';
import { sendFhirResponse } from '../response';
import { sendAsyncResponse } from './utils/asyncjobexecutor';

export const DEFAULT_VM_CONTEXT_TIMEOUT = 10000;

export interface BotExecutionRequest {
  readonly bot: Bot;
  readonly runAs: ProjectMembership;
  readonly input: any;
  readonly contentType: string;
  readonly subscription?: Subscription;
  readonly agent?: Agent;
  readonly device?: Device;
  readonly remoteAddress?: string;
  readonly forwardedFor?: string;
  readonly requestTime?: string;
  readonly traceId?: string;
  /** Headers from the original request, when invoked by HTTP request */
  readonly headers?: Record<string, string | string[] | undefined>;
  /** Default headers to add to MedplumClient, such as HTTP cookies */
  readonly defaultHeaders?: Record<string, string>;
}

export interface BotExecutionContext extends BotExecutionRequest {
  readonly accessToken: string;
  readonly secrets: Record<string, ProjectSetting>;
}

export interface BotExecutionResult {
  readonly success: boolean;
  readonly logResult: string;
  readonly returnValue?: any;
}

/**
 * Handles HTTP requests for the execute operation.
 * First reads the bot and makes sure it is valid and the user has access to it.
 * Then executes the bot.
 * Returns the outcome of the bot execution.
 * Assumes that input content-type is output content-type.
 */
export const executeHandler = asyncWrap(async (req: Request, res: Response) => {
  if (req.header('Prefer') === 'respond-async') {
    await sendAsyncResponse(req, res, async () => {
      const result = await executeOperation(req);
      if (isOperationOutcome(result) && !isOk(result)) {
        throw new OperationOutcomeError(result);
      }
      return getOutParametersFromResult(result);
    });
  } else {
    const result = await executeOperation(req);
    if (isOperationOutcome(result)) {
      sendOutcome(res, result);
      return;
    }

    const responseBody = getResponseBodyFromResult(result);
    const outcome = result.success ? allOk : badRequest(result.logResult);

    if (isResource(responseBody, 'Binary')) {
      await sendFhirResponse(req, res, outcome, responseBody);
      return;
    }

    // Send the response
    // The body parameter can be a Buffer object, a String, an object, Boolean, or an Array.
    res.status(getStatus(outcome)).type(getResponseContentType(req)).send(responseBody);
  }
});

async function executeOperation(req: Request): Promise<OperationOutcome | BotExecutionResult> {
  const ctx = getAuthenticatedContext();
  // First read the bot as the user to verify access
  const userBot = await getBotForRequest(req);
  if (!userBot) {
    return badRequest('Must specify bot ID or identifier.');
  }

  // Then read the bot as system user to load extended metadata
  const systemRepo = getSystemRepo();
  const bot = await systemRepo.readResource<Bot>('Bot', userBot.id);

  // Execute the bot
  // If the request is HTTP POST, then the body is the input
  // If the request is HTTP GET, then the query string is the input
  const result = await executeBot({
    bot,
    runAs: await getBotProjectMembership(ctx, bot),
    input: req.method === 'POST' ? req.body : req.query,
    contentType: req.header('content-type') as string,
    headers: req.headers,
    traceId: ctx.traceId,
    defaultHeaders: getBotDefaultHeaders(req, bot),
  });

  return result;
}

/**
 * Returns the Bot for the execute request.
 * If using "/Bot/:id/$execute", then the bot ID is read from the path parameter.
 * If using "/Bot/$execute?identifier=...", then the bot is searched by identifier.
 * Otherwise, returns undefined.
 * @param req - The HTTP request.
 * @returns The bot, or undefined if not found.
 */
async function getBotForRequest(req: Request): Promise<WithId<Bot> | undefined> {
  const ctx = getAuthenticatedContext();
  // Prefer to search by ID from path parameter
  const { id } = req.params;
  if (id) {
    return ctx.repo.readResource<Bot>('Bot', id);
  }

  // Otherwise, search by identifier
  const { identifier } = req.query;
  if (identifier && typeof identifier === 'string') {
    return ctx.repo.searchOne<Bot>({
      resourceType: 'Bot',
      filters: [{ code: 'identifier', operator: Operator.EXACT, value: identifier }],
    });
  }

  // If no bot ID or identifier, return undefined
  return undefined;
}

/**
 * Returns the bot's project membership.
 * If the bot is configured to run as the user, then use the current user's membership.
 * Otherwise, use the bot's project membership
 * @param ctx - The authenticated request context.
 * @param bot - The bot resource.
 * @returns The project membership for the bot.
 */
export async function getBotProjectMembership(
  ctx: AuthenticatedRequestContext,
  bot: WithId<Bot>
): Promise<ProjectMembership> {
  if (bot.runAsUser) {
    // If the bot is configured to run as the user, then use the current user's membership
    return ctx.membership;
  }
  // Otherwise, use the bot's project membership
  const project = bot.meta?.project as string;
  return (await findProjectMembership(project, createReference(bot))) ?? ctx.membership;
}

/**
 * Returns the default headers to add to the MedplumClient.
 * If the bot is configured to run as the user, then include the HTTP cookies from the request.
 * Otherwise, no default headers are added.
 * @param req - The HTTP request.
 * @param bot - The bot resource.
 * @returns The default headers to add to the MedplumClient.
 */
export function getBotDefaultHeaders(req: Request | FhirRequest, bot: WithId<Bot>): Record<string, string> | undefined {
  let defaultHeaders: Record<string, string> | undefined;
  if (bot.runAsUser) {
    defaultHeaders = {
      Cookie: req.headers?.cookie as string,
    };
  }
  return defaultHeaders;
}

/**
 * Executes a Bot.
 * This method ensures the bot is valid and enabled.
 * This method dispatches to the appropriate execution method.
 * @param request - The bot request.
 * @returns The bot execution result.
 */
export async function executeBot(request: BotExecutionRequest): Promise<BotExecutionResult> {
  const { bot, runAs } = request;
  const startTime = request.requestTime ?? new Date().toISOString();

  let result: BotExecutionResult;

  const execStart = process.hrtime.bigint();
  if (!(await isBotEnabled(bot))) {
    result = { success: false, logResult: 'Bots not enabled' };
  } else {
    await writeBotInputToStorage(request);

    const context: BotExecutionContext = {
      ...request,
      accessToken: await getBotAccessToken(runAs),
      secrets: await getBotSecrets(bot, runAs),
    };

    if (bot.runtimeVersion === 'awslambda') {
      result = await runInLambda(context);
    } else if (bot.runtimeVersion === 'vmcontext') {
      result = await runInVmContext(context);
    } else {
      result = { success: false, logResult: 'Unsupported bot runtime' };
    }
  }
  const executionTime = Number(process.hrtime.bigint() - execStart) / 1e9; // Report duration in seconds

  const attributes = { project: bot.meta?.project, bot: bot.id, outcome: result.success ? 'success' : 'failure' };
  recordHistogramValue('medplum.bot.execute.time', executionTime, { attributes });

  await createAuditEvent(
    request,
    startTime,
    result.success ? AuditEventOutcome.Success : AuditEventOutcome.MinorFailure,
    result.logResult
  );

  return result;
}

export function getResponseBodyFromResult(
  result: BotExecutionResult
): string | { [key: string]: any } | any[] | boolean {
  let responseBody = result.returnValue;
  if (responseBody === undefined) {
    // If the bot did not return a value, then return an OperationOutcome
    responseBody = result.success ? allOk : badRequest(result.logResult);
  } else if (typeof responseBody === 'number') {
    // If the bot returned a number, then we must convert it to a string
    // Otherwise, express will interpret it as an HTTP status code
    responseBody = responseBody.toString();
  }

  return responseBody;
}

function getOutParametersFromResult(result: OperationOutcome | BotExecutionResult): Parameters {
  const responseBody = isOperationOutcome(result) ? result : getResponseBodyFromResult(result);
  switch (typeof responseBody) {
    case 'string':
      return {
        resourceType: 'Parameters',
        parameter: [{ name: 'responseBody', valueString: responseBody }],
      };
    case 'object':
      if (isOperationOutcome(responseBody)) {
        return {
          resourceType: 'Parameters',
          parameter: [{ name: 'outcome', resource: responseBody }],
        };
      }
      return {
        resourceType: 'Parameters',
        parameter: [{ name: 'responseBody', valueString: JSON.stringify(responseBody) }],
      };
    case 'boolean':
      return {
        resourceType: 'Parameters',
        parameter: [{ name: 'responseBody', valueBoolean: responseBody }],
      };
    default:
      throw new OperationOutcomeError(serverError(new Error('Bot returned response.returnVal with an invalid type')));
  }
}

/**
 * Returns true if the bot is enabled and bots are enabled for the project.
 * @param bot - The bot resource.
 * @returns True if the bot is enabled.
 */
export async function isBotEnabled(bot: Bot): Promise<boolean> {
  const systemRepo = getSystemRepo();
  const project = await systemRepo.readResource<Project>('Project', bot.meta?.project as string);
  return !!project.features?.includes('bots');
}

/**
 * Writes the bot input to storage.
 * This is used both by AWS Lambda bots and VM context bots.
 *
 * There are 3 main reasons we do this:
 * 1. To ensure that the bot input is available for debugging.
 * 2. In the future, to support replaying bot executions.
 * 3. To support analytics on bot input.
 *
 * For the analytics use case, we align with Amazon guidelines for AWS Athena:
 * 1. Creating tables in Athena: https://docs.aws.amazon.com/athena/latest/ug/creating-tables.html
 * 2. Partitioning data in Athena: https://docs.aws.amazon.com/athena/latest/ug/partitions.html
 *
 * @param request - The bot request.
 */
async function writeBotInputToStorage(request: BotExecutionRequest): Promise<void> {
  const { bot, contentType, input } = request;
  const now = new Date();
  const today = now.toISOString().substring(0, 10).replaceAll('-', '/');
  const key = `bot/${bot.meta?.project}/${today}/${now.getTime()}-${randomUUID()}.json`;
  const row: Record<string, unknown> = {
    contentType,
    input,
    botId: bot.id,
    projectId: bot.meta?.project,
    accountId: bot.meta?.account,
    subscriptionId: request.subscription?.id,
    agentId: request.agent?.id,
    deviceId: request.device?.id,
    remoteAddress: request.remoteAddress,
    forwardedFor: request.forwardedFor,
  };

  if (contentType === ContentType.HL7_V2) {
    let hl7Message: Hl7Message | undefined = undefined;

    if (input instanceof Hl7Message) {
      hl7Message = request.input;
    } else if (typeof input === 'string') {
      try {
        hl7Message = Hl7Message.parse(request.input);
      } catch (err) {
        getLogger().debug(`Failed to parse HL7 message: ${normalizeErrorString(err)}`);
      }
    }

    if (hl7Message) {
      const msh = hl7Message.header;
      row.input = hl7Message.toString();
      row.hl7SendingApplication = msh.getComponent(3, 1);
      row.hl7SendingFacility = msh.getComponent(4, 1);
      row.hl7ReceivingApplication = msh.getComponent(5, 1);
      row.hl7ReceivingFacility = msh.getComponent(6, 1);
      row.hl7MessageType = msh.getComponent(9, 1);
      row.hl7Version = msh.getComponent(12, 1);

      const pid = hl7Message.getSegment('PID');
      row.hl7PidId = pid?.getComponent(2, 1);
      row.hl7PidMrn = pid?.getComponent(3, 1);

      const obx = hl7Message.getSegment('OBX');
      row.hl7ObxId = obx?.getComponent(3, 1);
      row.hl7ObxAccession = obx?.getComponent(18, 1);
    }
  }

  await getBinaryStorage().writeFile(key, ContentType.JSON, JSON.stringify(row));
}

/**
 * Executes a Bot on the server in a separate Node.js VM.
 * @param request - The bot request.
 * @returns The bot execution result.
 */
async function runInVmContext(request: BotExecutionContext): Promise<BotExecutionResult> {
  const { bot, input, contentType, traceId, headers } = request;

  const config = getConfig();
  if (!config.vmContextBotsEnabled) {
    return { success: false, logResult: 'VM Context bots not enabled on this server' };
  }

  const codeUrl = bot.executableCode?.url;
  if (!codeUrl) {
    return { success: false, logResult: 'No executable code' };
  }
  if (!codeUrl.startsWith('Binary/')) {
    return { success: false, logResult: 'Executable code is not a Binary' };
  }

  const systemRepo = getSystemRepo();
  const binary = await systemRepo.readReference<Binary>({ reference: codeUrl } as Reference<Binary>);
  const stream = await getBinaryStorage().readBinary(binary);
  const code = await readStreamToString(stream);
  const botConsole = new MockConsole();

  const sandbox = {
    console: botConsole,
    fetch,
    require,
    ContentType,
    Hl7Message,
    MedplumClient,
    TextEncoder,
    URL,
    URLSearchParams,
    event: {
      bot: createReference(bot),
      baseUrl: config.vmContextBaseUrl ?? config.baseUrl,
      accessToken: request.accessToken,
      input: input instanceof Hl7Message ? input.toString() : input,
      contentType,
      secrets: request.secrets,
      traceId,
      headers,
      defaultHeaders: request.defaultHeaders,
    },
  };

  const options: vm.RunningScriptOptions = {
    timeout: bot.timeout ? bot.timeout * 1000 : DEFAULT_VM_CONTEXT_TIMEOUT,
  };

  // Wrap code in an async block for top-level await support
  const wrappedCode = `
  const exports = {};
  const module = {exports};

  // Start user code
  ${code}
  // End user code

  (async () => {
    const { bot, baseUrl, accessToken, contentType, secrets, traceId, headers, defaultHeaders } = event;
    const medplum = new MedplumClient({
      baseUrl,
      defaultHeaders,
      fetch: function(url, options = {}) {
        options.headers ||= {};
        options.headers['X-Trace-Id'] = traceId;
        options.headers['traceparent'] = traceId;
        return fetch(url, options);
      },
    });
    medplum.setAccessToken(accessToken);
    try {
      let input = event.input;
      if (contentType === ContentType.HL7_V2 && input) {
        input = Hl7Message.parse(input);
      }
      let result = await exports.handler(medplum, { bot, input, contentType, secrets, traceId, headers });
      if (contentType === ContentType.HL7_V2 && result) {
        result = result.toString();
      }
      return result;
    } catch (err) {
      if (err instanceof Error) {
        console.log("Unhandled error: " + err.message + "\\n" + err.stack);
      } else if (typeof err === "object") {
        console.log("Unhandled error: " + JSON.stringify(err, undefined, 2));
      } else {
        console.log("Unhandled error: " + err);
      }
      throw err;
    }
  })();
  `;

  // Return the result of the code execution
  try {
    const returnValue = (await vm.runInNewContext(wrappedCode, sandbox, options)) as any;
    return {
      success: true,
      logResult: botConsole.toString(),
      returnValue,
    };
  } catch (err) {
    botConsole.log('Error', normalizeErrorString(err));
    return {
      success: false,
      logResult: botConsole.toString(),
      returnValue: normalizeOperationOutcome(err),
    };
  }
}

async function getBotAccessToken(runAs: ProjectMembership): Promise<string> {
  const systemRepo = getSystemRepo();

  // Create the Login resource
  const login = await systemRepo.createResource<Login>({
    resourceType: 'Login',
    authMethod: 'execute',
    user: runAs.user,
    membership: createReference(runAs),
    authTime: new Date().toISOString(),
    scope: 'openid',
    granted: true,
  });

  // Create the access token
  const accessToken = await generateAccessToken({
    login_id: login.id,
    sub: resolveId(runAs.user?.reference as Reference) as string,
    username: resolveId(runAs.user?.reference as Reference) as string,
    profile: runAs.profile?.reference as string,
    scope: 'openid',
  });

  return accessToken;
}

/**
 * Returns a collection of secrets for the bot.
 *
 * Secrets can come from 1-4 different sources. Order is important. The operating principles are:
 *
 *   1. Most specific beats more general - the runAs project secrets override the bot project secrets
 *   2. Defer to local control" - project admin secrets override system secrets
 *
 * From lowest to highest priority:
 *
 *   1. Bot project system secrets (if bot.system is true)
 *   2. Bot project secrets
 *   3. RunAs project system secrets (if bot.system is true and running in a different linked project)
 *   4. RunAs project secrets (if running in a different linked project)
 *
 * @param bot - The bot to get secrets for.
 * @param runAs - The project membership to get secrets for.
 * @returns The collection of secrets.
 */
async function getBotSecrets(bot: Bot, runAs: ProjectMembership): Promise<Record<string, ProjectSetting>> {
  const systemRepo = getSystemRepo();
  const botProjectId = bot.meta?.project as string;
  const runAsProjectId = resolveId(runAs.project) as string;
  const system = !!bot.system;
  const secrets: ProjectSetting[] = [];
  if (botProjectId !== runAsProjectId) {
    await addBotSecrets(systemRepo, botProjectId, system, secrets);
  }
  await addBotSecrets(systemRepo, runAsProjectId, system, secrets);
  return Object.fromEntries(secrets.map((s) => [s.name, s]));
}

async function addBotSecrets(
  systemRepo: Repository,
  projectId: string,
  system: boolean,
  out: ProjectSetting[]
): Promise<void> {
  const project = await systemRepo.readResource<Project>('Project', projectId);
  if (system && project.systemSecret) {
    out.push(...project.systemSecret);
  }
  if (project.secret) {
    out.push(...project.secret);
  }
}

const MIRRORED_CONTENT_TYPES: string[] = [ContentType.TEXT, ContentType.HL7_V2];

export function getResponseContentType(req: Request): string {
  const requestContentType = req.get('Content-Type');
  if (requestContentType && MIRRORED_CONTENT_TYPES.includes(requestContentType)) {
    return requestContentType;
  }

  // Default to JSON
  return ContentType.JSON;
}

/**
 * Creates an AuditEvent for a subscription attempt.
 * @param request - The bot request.
 * @param startTime - The time the execution attempt started.
 * @param outcome - The outcome code.
 * @param outcomeDesc - The outcome description text.
 */
async function createAuditEvent(
  request: BotExecutionRequest,
  startTime: string,
  outcome: AuditEventOutcome,
  outcomeDesc: string
): Promise<void> {
  const { bot, runAs } = request;
  const trigger = bot.auditEventTrigger ?? 'always';
  if (
    trigger === 'never' ||
    (trigger === 'on-error' && outcome === AuditEventOutcome.Success) ||
    (trigger === 'on-output' && outcomeDesc.length === 0)
  ) {
    return;
  }

  const auditEvent: AuditEvent = {
    resourceType: 'AuditEvent',
    meta: {
      project: resolveId(runAs.project) as string,
      account: bot.meta?.account,
    },
    period: {
      start: startTime,
      end: new Date().toISOString(),
    },
    recorded: new Date().toISOString(),
    type: {
      code: 'execute',
    },
    agent: [
      {
        type: {
          text: 'bot',
        },
        requestor: false,
      },
    ],
    source: {
      observer: createReference(bot) as Reference as Reference<Organization>,
    },
    entity: createAuditEventEntities(bot, request.input, request.subscription, request.agent, request.device),
    outcome,
    extension: buildTracingExtension(),
  };

  const config = getConfig();
  const destination = bot.auditEventDestination ?? ['resource'];
  if (destination.includes('resource')) {
    const systemRepo = getSystemRepo();
    const maxDescLength = config.maxBotLogLengthForResource ?? 10 * 1024;
    await systemRepo.createResource<AuditEvent>({
      ...auditEvent,
      outcomeDesc: outcomeDesc.substring(outcomeDesc.length - maxDescLength),
    });
  }
  if (destination.includes('log')) {
    const maxDescLength = config.maxBotLogLengthForLogs ?? 10 * 1024;
    logAuditEvent({
      ...auditEvent,
      outcomeDesc: outcomeDesc.substring(outcomeDesc.length - maxDescLength),
    });
  }
}
