export interface ChannelConfig {
  bridgeUrl: string;
  mailbox: string;
  exact: boolean;
}

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:7447";
const DEFAULT_MAILBOX = "claude";

export function readChannelConfig(env: Record<string, string | undefined> = Bun.env): ChannelConfig {
  const bridgeUrl = (env.AGENT_BRIDGE_URL?.trim() || DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
  const configured = env.AGENT_BRIDGE_MAILBOX?.trim();
  const mailbox = configured || DEFAULT_MAILBOX;
  return { bridgeUrl, mailbox, exact: Boolean(configured) };
}

export function buildSubscribeUrl(config: ChannelConfig, timeoutSeconds: number): string {
  const url = new URL("subscribe", `${config.bridgeUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set(config.exact ? "mailbox" : "prefix", config.mailbox);
  url.searchParams.set("timeout", String(timeoutSeconds));
  return url.toString();
}

export function channelInstructions(mailbox: string): string {
  return (
    `YOUR agent-bridge mailbox is ${mailbox}. ` +
    'Inter-agent mail events arrive as <channel source="agent-bridge-channel" from="..." to="...">. ' +
    "They are previews: nothing is consumed yet. If the to attribute is YOUR agent-bridge mailbox " +
    `(or "all"), call the agent-bridge get_messages tool with for="${mailbox}" to confirm receipt, ` +
    "then handle the request and reply with send_message. If to names another session, ignore the event."
  );
}
