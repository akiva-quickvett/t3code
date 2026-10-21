import { useAtomValue } from "@effect/atom-react";
import {
  chatTemplateStatusSummary,
  splitPhoneNumbers,
} from "@t3tools/client-runtime/state/chat-channels";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ChatChannel,
  ChatChannelCredentialName,
  ChatContact,
  ChatProductionAccess,
  ChatTemplateStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { confirmDestructive } from "../../confirmDialog";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const CREDENTIALS: ReadonlyArray<{
  readonly name: ChatChannelCredentialName;
  readonly label: string;
  readonly description: string;
}> = [
  {
    name: "accessToken",
    label: "Access token",
    description: "A WhatsApp Cloud API token for the business number.",
  },
  {
    name: "phoneNumberId",
    label: "Phone number ID",
    description: "The ID of the business number messages are sent from.",
  },
  {
    name: "appSecret",
    label: "App secret",
    description: "Checks that webhooks come from Meta. 32 hexadecimal characters.",
  },
  {
    name: "verifyToken",
    label: "Webhook verify token",
    description: "The token Meta echoes when it verifies the webhook.",
  },
];

const PRODUCTION_ACCESS_LABELS: Readonly<Record<ChatProductionAccess, string>> = {
  off: "Off",
  railway: "Railway (write-capable)",
  readOnlyDatabaseUrl: "Read-only database URL",
};

const RAILWAY_RISK =
  "Investigation pods get the Railway login, which can write to production: deploys, variables and the database. Read-only is a convention, not a credential limit.";

/** The failure's message, or null when the command succeeded or was interrupted. */
function failureMessage(result: Parameters<typeof isAtomCommandInterrupted>[0]): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

function reportFailure(title: string, result: Parameters<typeof isAtomCommandInterrupted>[0]) {
  const description = failureMessage(result);
  if (description !== null) toastManager.add({ type: "error", title, description });
}

const formatUpdatedAt = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

type MessagingDialog =
  | { readonly kind: "channel"; readonly channel: ChatChannel | null }
  | {
      readonly kind: "credential";
      readonly channel: ChatChannel;
      readonly name: ChatChannelCredentialName;
    }
  | {
      readonly kind: "contact";
      readonly channel: ChatChannel;
      readonly contact: ChatContact | null;
    };

/** Stock servers do not advertise chat channels, so their clients show nothing here. */
export function MessagingSettings() {
  const { environment: selected } = useSettingsScope();
  const supported =
    selected?.connection.phase === "connected" &&
    selected.serverConfig?.environment.capabilities.chatChannels === true;
  if (!supported) return null;
  return <MessagingPanel key={selected.environmentId} environmentId={selected.environmentId} />;
}

function MessagingPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    serverEnvironment.chatChannelsLive({ environmentId, input: {} }),
  );
  const canWrite = useAtomValue(serverEnvironment.mutateChatChannels.permissionAtom(environmentId));
  const mutate = useAtomCommand(serverEnvironment.mutateChatChannels, {
    label: "messaging remove",
    reportFailure: false,
  });
  const [dialog, setDialog] = useState<MessagingDialog | null>(null);
  const channels = query.data?.channels ?? [];
  const contacts = query.data?.contacts ?? [];

  const confirmRemoveChannel = async (channel: ChatChannel) => {
    const confirmed = await confirmDestructive(
      `Remove the ${channel.label} channel?\nIts credentials, contacts, message log and unsent messages are deleted.`,
    );
    if (!confirmed) return;
    reportFailure(
      "Could not remove the channel",
      await mutate({ environmentId, input: { type: "channel.remove", channelId: channel.id } }),
    );
  };
  const confirmRemoveContact = async (contact: ChatContact) => {
    const confirmed = await confirmDestructive(
      `Remove ${contact.displayName}?\nTheir numbers, message log and unsent messages are deleted.`,
    );
    if (!confirmed) return;
    reportFailure(
      "Could not remove the contact",
      await mutate({ environmentId, input: { type: "contact.remove", contactId: contact.id } }),
    );
  };

  return (
    <>
      <SettingsSection
        id="messaging"
        title="Messaging"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canWrite}
            onClick={() => setDialog({ kind: "channel", channel: null })}
          >
            <PlusIcon className="size-3" />
            Add WhatsApp channel
          </Button>
        }
      >
        {query.error ? (
          <SettingsRow title="Could not load messaging settings" description={query.error} />
        ) : null}
        {query.data && channels.length === 0 ? (
          <SettingsRow
            title="No channels"
            description="Add a WhatsApp channel to message people from this environment."
          />
        ) : null}
        {query.data ? (
          <ProductionAccessRow
            environmentId={environmentId}
            value={query.data.productionAccess}
            canWrite={canWrite}
          />
        ) : null}
      </SettingsSection>
      {channels.map((channel) => (
        <ChannelSection
          key={channel.id}
          environmentId={environmentId}
          channel={channel}
          contacts={contacts.filter((contact) => contact.channelId === channel.id)}
          canWrite={canWrite}
          onEdit={() => setDialog({ kind: "channel", channel })}
          onRemove={() => void confirmRemoveChannel(channel)}
          onSetCredential={(name) => setDialog({ kind: "credential", channel, name })}
          onEditContact={(contact) => setDialog({ kind: "contact", channel, contact })}
          onRemoveContact={(contact) => void confirmRemoveContact(contact)}
        />
      ))}
      {dialog?.kind === "channel" ? (
        <ChannelDialog
          environmentId={environmentId}
          channel={dialog.channel}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "credential" ? (
        <CredentialDialog
          environmentId={environmentId}
          channel={dialog.channel}
          name={dialog.name}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "contact" ? (
        <ContactDialog
          environmentId={environmentId}
          channel={dialog.channel}
          contact={dialog.contact}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

function ProductionAccessRow(props: {
  readonly environmentId: EnvironmentId;
  readonly value: ChatProductionAccess;
  readonly canWrite: boolean;
}) {
  const setAccess = useAtomCommand(serverEnvironment.mutateChatChannels, {
    label: "messaging production access",
    reportFailure: false,
  });
  const change = async (value: ChatProductionAccess) => {
    // The write-capable option is confirmed first; turning it off is one click.
    if (value === "railway") {
      const confirmed = await confirmDestructive(
        `Give investigation pods Railway access?\n${RAILWAY_RISK}`,
      );
      if (!confirmed) return;
    }
    reportFailure(
      "Could not change production access",
      await setAccess({
        environmentId: props.environmentId,
        input: { type: "productionAccess.set", value },
      }),
    );
  };
  return (
    <SettingsRow
      {...searchableSetting("messaging-production-access")}
      description={
        <span className="flex flex-col gap-1">
          <span>
            Where investigation pods may reach production. Only the investigator role uses it.
          </span>
          {props.value === "railway" ? (
            <span className="text-destructive-foreground" role="alert">
              {RAILWAY_RISK}
            </span>
          ) : null}
        </span>
      }
      control={
        <Select
          disabled={!props.canWrite}
          value={props.value}
          onValueChange={(value) => {
            if (value === "off" || value === "railway") void change(value);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-52" aria-label="Production access">
            <SelectValue>{PRODUCTION_ACCESS_LABELS[props.value]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="off">
              {PRODUCTION_ACCESS_LABELS.off}
            </SelectItem>
            <SelectItem hideIndicator value="railway">
              {PRODUCTION_ACCESS_LABELS.railway}
            </SelectItem>
            <SelectItem hideIndicator disabled value="readOnlyDatabaseUrl">
              {PRODUCTION_ACCESS_LABELS.readOnlyDatabaseUrl} (arrives in M20)
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

function ChannelSection(props: {
  readonly environmentId: EnvironmentId;
  readonly channel: ChatChannel;
  readonly contacts: ReadonlyArray<ChatContact>;
  readonly canWrite: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onSetCredential: (name: ChatChannelCredentialName) => void;
  readonly onEditContact: (contact: ChatContact | null) => void;
  readonly onRemoveContact: (contact: ChatContact) => void;
}) {
  const { channel } = props;
  return (
    <SettingsSection
      title={`WhatsApp · ${channel.label}`}
      headerAction={
        <Menu>
          <MenuTrigger
            disabled={!props.canWrite}
            render={
              <Button size="icon-xs" variant="ghost" aria-label={`${channel.label} actions`}>
                <MoreHorizontalIcon />
              </Button>
            }
          />
          <MenuPopup align="end">
            <MenuItem onClick={props.onEdit}>Edit</MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={props.onRemove}>
              Remove channel
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
    >
      {CREDENTIALS.map((credential) => {
        const status = channel.credentials.find(({ name }) => name === credential.name);
        return (
          <SettingsRow
            key={credential.name}
            title={credential.label}
            description={credential.description}
            status={
              status?.set ? (
                <Badge variant="success" size="sm">
                  Set{status.updatedAt ? ` · ${formatUpdatedAt(status.updatedAt)}` : ""}
                </Badge>
              ) : (
                <Badge variant="warning" size="sm">
                  Not set
                </Badge>
              )
            }
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!props.canWrite}
                onClick={() => props.onSetCredential(credential.name)}
              >
                {status?.set ? "Replace" : "Set"}
              </Button>
            }
          />
        );
      })}
      <TemplateStatusRow
        // A checked status belongs to the template it was read for.
        key={`${channel.notifyTemplate?.name}:${channel.notifyTemplate?.language}`}
        environmentId={props.environmentId}
        channel={channel}
        canWrite={props.canWrite}
      />
      <SettingsRow
        title="Contacts"
        description="People this channel may message. Only their numbers' last two digits are shown."
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={!props.canWrite}
            onClick={() => props.onEditContact(null)}
          >
            <PlusIcon className="size-3" />
            Add contact
          </Button>
        }
      />
      {props.contacts.map((contact) => (
        <SettingsRow
          key={contact.id}
          title={contact.displayName}
          description={
            <span className="flex flex-col gap-0.5">
              <span className="font-mono">{contact.slug}</span>
              <span>{contact.phoneNumbers.join(", ")}</span>
            </span>
          }
          control={
            <span className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger render={<span tabIndex={0} />}>
                  <Button size="xs" variant="outline" disabled>
                    Create bot thread
                  </Button>
                </TooltipTrigger>
                <TooltipPopup side="top">Bot threads arrive in M16.</TooltipPopup>
              </Tooltip>
              <Menu>
                <MenuTrigger
                  disabled={!props.canWrite}
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`${contact.displayName} actions`}
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  }
                />
                <MenuPopup align="end">
                  <MenuItem onClick={() => props.onEditContact(contact)}>Edit</MenuItem>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={() => props.onRemoveContact(contact)}>
                    Remove
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </span>
          }
        />
      ))}
    </SettingsSection>
  );
}

function TemplateStatusRow(props: {
  readonly environmentId: EnvironmentId;
  readonly channel: ChatChannel;
  readonly canWrite: boolean;
}) {
  const check = useAtomCommand(serverEnvironment.checkChatTemplateStatus, {
    label: "messaging template status",
    reportFailure: false,
  });
  const [status, setStatus] = useState<ChatTemplateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const template = props.channel.notifyTemplate;
  const summary = status === null ? null : chatTemplateStatusSummary(status);

  const run = async () => {
    setChecking(true);
    const result = await check({
      environmentId: props.environmentId,
      input: { channelId: props.channel.id },
    });
    setChecking(false);
    if (result._tag === "Success") setStatus(result.value);
    else reportFailure("Could not read the template status", result);
  };

  return (
    <SettingsRow
      title="Notify template"
      description={
        template === null
          ? "None set. Messages outside the 24-hour window wait for the person to write."
          : `${template.name} (${template.language}). Sent when a message must wait for the 24-hour window; it must be an approved UTILITY template.`
      }
      status={
        summary === null ? null : (
          <Badge variant={summary.tone} size="sm">
            {summary.label}
          </Badge>
        )
      }
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={!props.canWrite || template === null || checking}
          onClick={() => void run()}
        >
          Check status
        </Button>
      }
    />
  );
}

function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={props.htmlFor}>
        <span>{props.label}</span>
        {props.hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{props.hint}</span>
        ) : null}
      </Label>
      {props.children}
    </div>
  );
}

function DialogError({ message }: { readonly message: string | null }) {
  return message === null ? null : (
    <p className="text-destructive-foreground text-sm" role="alert">
      {message}
    </p>
  );
}

function ChannelDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly channel: ChatChannel | null;
  readonly onClose: () => void;
}) {
  const upsert = useAtomCommand(serverEnvironment.mutateChatChannels, {
    label: "messaging channel save",
    reportFailure: false,
  });
  const [label, setLabel] = useState(props.channel?.label ?? "BugBot");
  const [businessAccountId, setBusinessAccountId] = useState(
    props.channel?.businessAccountId ?? "",
  );
  const [templateName, setTemplateName] = useState(props.channel?.notifyTemplate?.name ?? "");
  const [templateLanguage, setTemplateLanguage] = useState(
    props.channel?.notifyTemplate?.language ?? "en",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const result = await upsert({
      environmentId: props.environmentId,
      input: {
        type: "channel.upsert",
        ...(props.channel === null ? {} : { id: props.channel.id }),
        kind: "whatsapp",
        label,
        businessAccountId: businessAccountId.trim() === "" ? null : businessAccountId,
        notifyTemplate:
          templateName.trim() === "" ? null : { name: templateName, language: templateLanguage },
      },
    });
    setSaving(false);
    const failure = failureMessage(result);
    if (failure !== null) return setError(failure);
    if (result._tag === "Success") props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {props.channel === null ? "Add WhatsApp channel" : `Edit ${props.channel.label}`}
          </DialogTitle>
          <DialogDescription>
            Credentials are entered separately after the channel exists and are never shown again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-4">
            <Field label="Name" htmlFor="messaging-channel-label">
              <Input
                id="messaging-channel-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
            <Field
              label="WhatsApp Business Account ID"
              hint="Required with a notify template"
              htmlFor="messaging-channel-waba"
            >
              <Input
                id="messaging-channel-waba"
                inputMode="numeric"
                value={businessAccountId}
                onChange={(event) => setBusinessAccountId(event.target.value)}
              />
            </Field>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <Field label="Notify template" hint="Optional" htmlFor="messaging-channel-template">
                <Input
                  id="messaging-channel-template"
                  placeholder="bugbot_notice"
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                />
              </Field>
              <Field label="Language" htmlFor="messaging-channel-template-language">
                <Input
                  id="messaging-channel-template-language"
                  value={templateLanguage}
                  onChange={(event) => setTemplateLanguage(event.target.value)}
                />
              </Field>
            </div>
            <DialogError message={error} />
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button disabled={saving || label.trim() === ""} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Write-only: the value goes to the server's secret store and leaves this dialog with it. */
function CredentialDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly channel: ChatChannel;
  readonly name: ChatChannelCredentialName;
  readonly onClose: () => void;
}) {
  const setCredential = useAtomCommand(serverEnvironment.mutateChatChannels, {
    label: "messaging credential save",
    reportFailure: false,
  });
  const credential = CREDENTIALS.find(({ name }) => name === props.name)!;
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const result = await setCredential({
      environmentId: props.environmentId,
      input: {
        type: "channel.setCredential",
        channelId: props.channel.id,
        name: props.name,
        value,
      },
    });
    setSaving(false);
    const failure = failureMessage(result);
    if (failure !== null) return setError(failure);
    if (result._tag === "Success") props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{credential.label}</DialogTitle>
          <DialogDescription>
            {credential.description} Stored in this environment's secret store; it is never shown
            again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-4">
            <Field label={credential.label} htmlFor="messaging-credential-value">
              <Input
                id="messaging-credential-value"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
            <DialogError message={error} />
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button disabled={saving || value.trim() === ""} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ContactDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly channel: ChatChannel;
  readonly contact: ChatContact | null;
  readonly onClose: () => void;
}) {
  const upsert = useAtomCommand(serverEnvironment.mutateChatChannels, {
    label: "messaging contact save",
    reportFailure: false,
  });
  const [displayName, setDisplayName] = useState(props.contact?.displayName ?? "");
  const [slug, setSlug] = useState(props.contact?.slug ?? "");
  const [numbers, setNumbers] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const phoneNumbers = splitPhoneNumbers(numbers);

  const save = async () => {
    setSaving(true);
    const result = await upsert({
      environmentId: props.environmentId,
      input: {
        type: "contact.upsert",
        channelId: props.channel.id,
        ...(props.contact === null ? {} : { id: props.contact.id }),
        slug,
        displayName,
        ...(phoneNumbers.length === 0 ? {} : { phoneNumbers }),
      },
    });
    setSaving(false);
    const failure = failureMessage(result);
    if (failure !== null) return setError(failure);
    if (result._tag === "Success") props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {props.contact === null ? "Add contact" : `Edit ${props.contact.displayName}`}
          </DialogTitle>
          <DialogDescription>
            Numbers are kept in this environment's secret store and shown masked afterwards.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" htmlFor="messaging-contact-name">
                <Input
                  id="messaging-contact-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
              <Field label="Slug" hint="Lowercase, e.g. akiva" htmlFor="messaging-contact-slug">
                <Input
                  id="messaging-contact-slug"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Phone numbers"
              hint="International format, one per line"
              htmlFor="messaging-contact-numbers"
            >
              <Textarea
                id="messaging-contact-numbers"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  props.contact === null
                    ? "+1 555 0100"
                    : `Leave empty to keep ${props.contact.phoneNumbers.join(", ")}`
                }
                value={numbers}
                onChange={(event) => setNumbers(event.target.value)}
              />
            </Field>
            <DialogError message={error} />
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            disabled={
              saving ||
              displayName.trim() === "" ||
              slug.trim() === "" ||
              (props.contact === null && phoneNumbers.length === 0)
            }
            onClick={() => void save()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
