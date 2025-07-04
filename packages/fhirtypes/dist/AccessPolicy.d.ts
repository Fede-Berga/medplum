/*
 * This is a generated file
 * Do not edit manually.
 */

import { Expression } from './Expression';
import { Extension } from './Extension';
import { Meta } from './Meta';
import { Narrative } from './Narrative';
import { Reference } from './Reference';
import { Resource } from './Resource';

/**
 * Access Policy for user or user group that defines how entities can or
 * cannot access resources.
 */
export interface AccessPolicy {

  /**
   * This is a AccessPolicy resource
   */
  readonly resourceType: 'AccessPolicy';

  /**
   * The logical id of the resource, as used in the URL for the resource.
   * Once assigned, this value never changes.
   */
  id?: string;

  /**
   * The metadata about the resource. This is content that is maintained by
   * the infrastructure. Changes to the content might not always be
   * associated with version changes to the resource.
   */
  meta?: Meta;

  /**
   * A reference to a set of rules that were followed when the resource was
   * constructed, and which must be understood when processing the content.
   * Often, this is a reference to an implementation guide that defines the
   * special rules along with other profiles etc.
   */
  implicitRules?: string;

  /**
   * The base language in which the resource is written.
   */
  language?: string;

  /**
   * A human-readable narrative that contains a summary of the resource and
   * can be used to represent the content of the resource to a human. The
   * narrative need not encode all the structured data, but is required to
   * contain sufficient detail to make it &quot;clinically safe&quot; for a human to
   * just read the narrative. Resource definitions may define what content
   * should be represented in the narrative to ensure clinical safety.
   */
  text?: Narrative;

  /**
   * These resources do not have an independent existence apart from the
   * resource that contains them - they cannot be identified independently,
   * and nor can they have their own independent transaction scope.
   */
  contained?: Resource[];

  /**
   * May be used to represent additional information that is not part of
   * the basic definition of the resource. To make the use of extensions
   * safe and manageable, there is a strict set of governance  applied to
   * the definition and use of extensions. Though any implementer can
   * define an extension, there is a set of requirements that SHALL be met
   * as part of the definition of the extension.
   */
  extension?: Extension[];

  /**
   * May be used to represent additional information that is not part of
   * the basic definition of the resource and that modifies the
   * understanding of the element that contains it and/or the understanding
   * of the containing element's descendants. Usually modifier elements
   * provide negation or qualification. To make the use of extensions safe
   * and manageable, there is a strict set of governance applied to the
   * definition and use of extensions. Though any implementer is allowed to
   * define an extension, there is a set of requirements that SHALL be met
   * as part of the definition of the extension. Applications processing a
   * resource are required to check for modifier extensions.
   *
   * Modifier extensions SHALL NOT change the meaning of any elements on
   * Resource or DomainResource (including cannot change the meaning of
   * modifierExtension itself).
   */
  modifierExtension?: Extension[];

  /**
   * A name associated with the AccessPolicy.
   */
  name?: string;

  /**
   * Other access policies used to derive this access policy.
   */
  basedOn?: Reference<AccessPolicy>[];

  /**
   * Optional compartment for newly created resources.  If this field is
   * set, any resources created by a user with this access policy will
   * automatically be included in the specified compartment.
   */
  compartment?: Reference;

  /**
   * Access details for a resource type.
   */
  resource?: AccessPolicyResource[];

  /**
   * Use IP Access Rules to allowlist, block, and challenge traffic based
   * on the visitor IP address.
   */
  ipAccessRule?: AccessPolicyIpAccessRule[];
}

/**
 * Use IP Access Rules to allowlist, block, and challenge traffic based
 * on the visitor IP address.
 */
export interface AccessPolicyIpAccessRule {

  /**
   * Friendly name that will make it easy for you to identify the IP Access
   * Rule in the future.
   */
  name?: string;

  /**
   * An IP Access rule will apply a certain action to incoming traffic
   * based on the visitor IP address or IP range.
   */
  value: string;

  /**
   * Access rule can perform one of the following actions: &quot;allow&quot; |
   * &quot;block&quot;.
   */
  action: 'allow' | 'block';
}

/**
 * Access details for a resource type.
 */
export interface AccessPolicyResource {

  /**
   * The resource type.
   */
  resourceType: string;

  /**
   * @deprecated Optional compartment restriction for the resource type.
   */
  compartment?: Reference;

  /**
   * The rules that the server should use to determine which resources to
   * allow.
   */
  criteria?: string;

  /**
   * @deprecated Use AccessPolicy.resource.interaction = ['search', 'read',
   * 'vread', 'history']
   */
  readonly?: boolean;

  /**
   * Permitted FHIR interactions with this resource type
   */
  interaction?: ('read' | 'vread' | 'update' | 'delete' | 'history' | 'create' | 'search')[];

  /**
   * Optional list of hidden fields.  Hidden fields are not readable or
   * writeable.
   */
  hiddenFields?: string[];

  /**
   * Optional list of read-only fields.  Read-only fields are readable but
   * not writeable.
   */
  readonlyFields?: string[];

  /**
   * Invariants that must be satisfied for the resource to be written.  Can
   * include %before and %after placeholders to refer to the resource
   * before and after the updates are applied.
   */
  writeConstraint?: Expression[];
}
