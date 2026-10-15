// THE SHARE DIALOG (SPEC.md 21.8): members with role pickers, "Invite by email" with a role, the
// pending invitations and link sharing -- for the owner. Everyone else sees who is on the deck,
// read-only. One component for the deck list and the editor's top bar (`EditorHost.topBarAccessory`).
//
// Key decisions:
//
//  * PRESENTATION AND REQUESTS ARE SEPARATE. `ShareDialog` renders a `DeckDetailsBody` and calls its
//    properties; `createShareActions` turns those calls into deck API requests and answers the new
//    details; `ShareDialogContainer` holds the two together with the dialog's small local state.
//    The first two are tested without a browser.
//  * WHAT A ROLE MAY DO COMES FROM THE CONTRACT'S TABLE (`roleAllows(..., "share")`), never from
//    `role === "owner"`; the server enforces it again regardless.
//  * LINK SHARING OFFERS EXACTLY THE CONTRACT'S CHOICES: off, viewer, commenter. Never editor
//    (deck-access.ts: an editor could rewrite every slide).

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import { roleAllows, type DeckRole, type LinkSharing } from "../../contracts/deck-access.ts";
import type { DeckDetailsBody, InviteRequest } from "../../contracts/deck-api.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { okBodyOf, problemOf, type ApiResult, type DeckClient } from "../api/deck-api-client.ts";
import { DialogFrame, roleLabel } from "../shared/web-chrome.tsx";
import { WEB_CLASS } from "../web-stylesheet.ts";

export type InvitableRole = InviteRequest["role"];

export const INVITABLE_ROLES: readonly InvitableRole[] = ["editor", "commenter", "viewer"];

/** The contract's link sharing choices, in the order the dialog offers them. */
export const LINK_SHARING_CHOICES: readonly Readonly<{ value: string; label: string; linkSharing: LinkSharing }>[] = [
  { value: "off", label: "Only people added here", linkSharing: { kind: "off" } },
  { value: "viewer", label: "Anyone signed in with the link can view", linkSharing: { kind: "anyoneSignedIn", role: "viewer" } },
  { value: "commenter", label: "Anyone signed in with the link can comment", linkSharing: { kind: "anyoneSignedIn", role: "commenter" } },
];

export type InviteDraft = Readonly<{ email: string; role: InvitableRole }>;

export type ShareDialogProperties = Readonly<{
  details: DeckDetailsBody;
  draft: InviteDraft;
  busy: boolean;
  problem: string | null;
  onDraftChange: (draft: InviteDraft) => void;
  onInvite: () => void;
  onChangeMember: (options: Readonly<{ personId: string; role: InvitableRole }>) => void;
  onRemoveMember: (personId: string) => void;
  onCancelInvitation: (invitationId: string) => void;
  onLinkSharingChange: (linkSharing: LinkSharing) => void;
  onClose: () => void;
}>;

export function ShareDialog(properties: ShareDialogProperties): ReactElement {
  const { details } = properties;
  const mayShare = roleAllows({ role: details.deck.role, permission: "share" });
  return (
    <DialogFrame title={`Share "${details.deck.title}"`} onClose={properties.onClose}>
      <h3 className={WEB_CLASS.sectionTitle}>People with access</h3>
      <ul className={WEB_CLASS.people} aria-label="People with access">
        {details.members.map((member) => (
          <li key={member.person.id} className={WEB_CLASS.person}>
            <span className={WEB_CLASS.personName}>
              <span>{member.person.displayName}</span>
              {member.email === null ? null : <span className={TIDEPOOL_CLASS.subtle}>{member.email}</span>}
            </span>
            {mayShare && ownerRole(member.role) === null ? (
              <span className={WEB_CLASS.personControls}>
                <RolePicker label={`Role of ${member.person.displayName}`} role={invitableOrEditor(member.role)} disabled={properties.busy} onChange={(role) => properties.onChangeMember({ personId: member.person.id, role })} />
                <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={properties.busy} onClick={() => properties.onRemoveMember(member.person.id)}>
                  Remove
                </button>
              </span>
            ) : (
              <span className={TIDEPOOL_CLASS.muted}>{roleLabel(member.role)}</span>
            )}
          </li>
        ))}
      </ul>
      {mayShare ? <OwnerControls {...properties} /> : <p className={TIDEPOOL_CLASS.muted}>{linkSharingSentence(details.linkSharing)} Only the owner can change who has access.</p>}
      {properties.problem === null ? null : (
        <p className={WEB_CLASS.problem} role="alert">
          {properties.problem}
        </p>
      )}
      <div className={WEB_CLASS.formRow}>
        <button type="button" className={TIDEPOOL_CLASS.primaryPill} onClick={properties.onClose}>
          Done
        </button>
      </div>
    </DialogFrame>
  );
}

function OwnerControls(properties: ShareDialogProperties): ReactElement {
  const { details, draft } = properties;
  return (
    <>
      <form
        className={WEB_CLASS.form}
        onSubmit={(event) => {
          event.preventDefault();
          properties.onInvite();
        }}
      >
        <h3 className={WEB_CLASS.sectionTitle}>Invite by email</h3>
        <div className={WEB_CLASS.formRow}>
          <input
            className={TIDEPOOL_CLASS.field}
            type="email"
            required
            placeholder="name@example.com"
            aria-label="Email address"
            value={draft.email}
            disabled={properties.busy}
            onChange={(event) => properties.onDraftChange({ ...draft, email: event.currentTarget.value })}
          />
          <RolePicker label="Role for the invitation" role={draft.role} disabled={properties.busy} onChange={(role) => properties.onDraftChange({ ...draft, role })} />
          <button type="submit" className={TIDEPOOL_CLASS.primaryPill} disabled={properties.busy}>
            Invite
          </button>
        </div>
      </form>
      {details.invitations.length === 0 ? null : (
        <>
          <h3 className={WEB_CLASS.sectionTitle}>Invited, not signed in yet</h3>
          <ul className={WEB_CLASS.people} aria-label="Pending invitations">
            {details.invitations.map((invitation) => (
              <li key={invitation.invitationId} className={WEB_CLASS.person}>
                <span className={WEB_CLASS.personName}>
                  <span>{invitation.email}</span>
                  <span className={TIDEPOOL_CLASS.subtle}>{roleLabel(invitation.role)}</span>
                </span>
                <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={properties.busy} onClick={() => properties.onCancelInvitation(invitation.invitationId)}>
                  Cancel invitation
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <fieldset className={WEB_CLASS.form} aria-label="Link sharing">
        <h3 className={WEB_CLASS.sectionTitle}>Link sharing</h3>
        {LINK_SHARING_CHOICES.map((choice) => (
          <label key={choice.value} className={WEB_CLASS.formRow}>
            <input
              type="radio"
              name="link-sharing"
              value={choice.value}
              checked={linkSharingValue(details.linkSharing) === choice.value}
              disabled={properties.busy}
              onChange={() => properties.onLinkSharingChange(choice.linkSharing)}
            />
            {choice.label}
          </label>
        ))}
      </fieldset>
    </>
  );
}

function RolePicker(properties: Readonly<{ label: string; role: InvitableRole; disabled: boolean; onChange: (role: InvitableRole) => void }>): ReactElement {
  return (
    <select
      className={TIDEPOOL_CLASS.field}
      aria-label={properties.label}
      value={properties.role}
      disabled={properties.disabled}
      onChange={(event) => {
        const role = INVITABLE_ROLES.find((candidate) => candidate === event.currentTarget.value);
        if (role !== undefined) properties.onChange(role);
      }}
    >
      {INVITABLE_ROLES.map((role) => (
        <option key={role} value={role}>
          {roleLabel(role)}
        </option>
      ))}
    </select>
  );
}

/** The request an invite draft makes, or null when the address cannot be one. */
export function inviteRequestOf(draft: InviteDraft): InviteRequest | null {
  const email = draft.email.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  return { email, role: draft.role };
}

export type ShareActions = Readonly<{
  load: () => Promise<ApiResult<DeckDetailsBody>>;
  invite: (draft: InviteDraft) => Promise<ApiResult<DeckDetailsBody>>;
  changeMember: (options: Readonly<{ personId: string; role: InvitableRole }>) => Promise<ApiResult<DeckDetailsBody>>;
  removeMember: (personId: string) => Promise<ApiResult<DeckDetailsBody>>;
  cancelInvitation: (invitationId: string) => Promise<ApiResult<DeckDetailsBody>>;
  changeLinkSharing: (linkSharing: LinkSharing) => Promise<ApiResult<DeckDetailsBody>>;
}>;

/** Each dialog action as its deck API request, answering the deck's new details. */
export function createShareActions(deck: DeckClient): ShareActions {
  return {
    load: () => deck.details(),
    invite: async (draft) => {
      const request = inviteRequestOf(draft);
      if (request === null) return { kind: "failed", status: 400, error: { error: "invalidRequest", message: "That is not an email address.", signInAddress: null, connectAddress: null, retryAfterSeconds: null } };
      const result = await deck.invite(request);
      const body = okBodyOf(result);
      return body === null ? withoutBody(result) : { kind: "ok", body: body.details };
    },
    changeMember: (change) => deck.changeMember({ personId: change.personId, request: { role: change.role } }),
    removeMember: (personId) => deck.removeMember(personId),
    cancelInvitation: (invitationId) => deck.cancelInvitation(invitationId),
    changeLinkSharing: (linkSharing) => deck.updateSharing({ linkSharing }),
  };
}

/** The share dialog with its requests: loads the details, then keeps them current after each change. */
export function ShareDialogContainer(properties: Readonly<{ deck: DeckClient; onClose: () => void }>): ReactElement {
  const actions = useActions(properties.deck);
  const [details, setDetails] = useState<DeckDetailsBody | null>(null);
  const [draft, setDraft] = useState<InviteDraft>({ email: "", role: "editor" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = useCallback(async (request: () => Promise<ApiResult<DeckDetailsBody>>, after?: () => void) => {
    setBusy(true);
    setProblem(null);
    const result = await request();
    setBusy(false);
    const body = okBodyOf(result);
    if (body === null) {
      setProblem(problemOf(result));
      return;
    }
    setDetails(body);
    after?.();
  }, []);

  useEffect(() => {
    void run(actions.load);
  }, [actions, run]);

  if (details === null) {
    return (
      <DialogFrame title="Share" onClose={properties.onClose}>
        <p className={problem === null ? TIDEPOOL_CLASS.muted : WEB_CLASS.problem}>{problem ?? "Loading who has access..."}</p>
      </DialogFrame>
    );
  }
  return (
    <ShareDialog
      details={details}
      draft={draft}
      busy={busy}
      problem={problem}
      onDraftChange={setDraft}
      onInvite={() => void run(() => actions.invite(draft), () => setDraft({ email: "", role: draft.role }))}
      onChangeMember={(change) => void run(() => actions.changeMember(change))}
      onRemoveMember={(personId) => void run(() => actions.removeMember(personId))}
      onCancelInvitation={(invitationId) => void run(() => actions.cancelInvitation(invitationId))}
      onLinkSharingChange={(linkSharing) => void run(() => actions.changeLinkSharing(linkSharing))}
      onClose={properties.onClose}
    />
  );
}

function useActions(deck: DeckClient): ShareActions {
  const [actions] = useState(() => createShareActions(deck));
  return actions;
}

function withoutBody(result: ApiResult<unknown>): ApiResult<never> {
  switch (result.kind) {
    case "ok":
      return { kind: "unreachable", message: "unexpected" };
    case "failed":
    case "unreachable":
      return result;
    default:
      return assertNever(result);
  }
}

/** "owner" for the owner, whose role nobody changes; null for every role an invitation can grant. */
function ownerRole(role: DeckRole): "owner" | null {
  switch (role) {
    case "owner":
      return role;
    case "editor":
    case "commenter":
    case "viewer":
      return null;
    default:
      return assertNever(role);
  }
}

function linkSharingVerb(role: "viewer" | "commenter"): string {
  switch (role) {
    case "viewer":
      return "view";
    case "commenter":
      return "comment";
    default:
      return assertNever(role);
  }
}

function invitableOrEditor(role: DeckRole): InvitableRole {
  switch (role) {
    case "owner":
    case "editor":
      return "editor";
    case "commenter":
    case "viewer":
      return role;
    default:
      return assertNever(role);
  }
}

function linkSharingValue(linkSharing: LinkSharing): string {
  switch (linkSharing.kind) {
    case "off":
      return "off";
    case "anyoneSignedIn":
      return linkSharing.role;
    default:
      return assertNever(linkSharing);
  }
}

function linkSharingSentence(linkSharing: LinkSharing): string {
  switch (linkSharing.kind) {
    case "off":
      return "Only the people listed here can open this deck.";
    case "anyoneSignedIn":
      return `Anyone signed in with the link can ${linkSharingVerb(linkSharing.role)}.`;
    default:
      return assertNever(linkSharing);
  }
}
