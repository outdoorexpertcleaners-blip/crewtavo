/**
 * Quo on Apps → Quo (lib/quo.ts, core/quo.ts): practice mode, connecting the business's Quo
 * workspace (its API key and a line per brand), the test numbers, asking Quo to send incoming texts
 * here, pretending a test number texted back, and the webhook Quo posts incoming texts to.
 *
 * Test only is on from the start and nothing here turns it off: until the business goes live, only
 * the test numbers are texted, and a text from any other number is dropped without being kept.
 */
import { ADMINS } from "@crewtavo/core";
import { asksToStopTexts, smsKeyword } from "@crewtavo/core/marketing";
import { parseTestNumbers, quoIncomingText, quoNumberAllowed, quoSettings, type QuoIncomingText, type QuoLine, type QuoSettings } from "@crewtavo/core/quo";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { kickAutomations } from "../lib/background";
import { appUrl, asJson, dbError, HttpError, readJson } from "../lib/http";
import { companyQuo, createQuoWebhook, forgetQuo, quoLines, QuoProblem, quoSigned } from "../lib/quo";
import { adminClient, type Db } from "../lib/supabase";
import { loadSecret, saveSecret } from "../integrations/tokens";
import { receiveText } from "../services/inboundTexts";

export const quo = new Hono<AppEnv>();

const PRACTICE_LINES: QuoSettings["lines"] = {
  washing: { id: "practice-washing", number: "", name: "Wash line (practice)" },
  lights: { id: "practice-lights", number: "", name: "Lighting line (practice)" },
};

/** Where Quo posts this company's incoming texts. */
export const quoWebhookUrl = (base: string, companyId: string) => `${base}/api/webhooks/quo/${companyId}`;

/** Quo on its app page: practice or connected, the lines, the test numbers and whether incoming texts come here. */
export function quoState(base: string, companyId: string, row: { status: string; settings: unknown } | undefined) {
  if (!row || row.status === "disconnected") return null;
  const s = quoSettings(row.settings);
  return {
    practice: s.practice,
    test_only: s.test_only,
    test_numbers: s.test_numbers,
    lines: s.lines,
    webhook_set: Boolean(s.webhook_id),
    webhook_url: quoWebhookUrl(base, companyId),
    reachable: base.startsWith("https://"),
  };
}

const numbers = z.union([z.string().max(2000), z.array(z.string().max(40)).max(20)]);
const testNumbers = (input: string | string[]) => {
  try {
    return parseTestNumbers(input);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
};

async function save(env: Env, companyId: string, userId: string, settings: QuoSettings, label: string) {
  const { error } = await adminClient(env).from("integrations").upsert({
    company_id: companyId, provider: "quo", status: "connected", account_label: label.slice(0, 200), settings: asJson(settings),
    connected_by: userId, connected_at: new Date().toISOString(), last_error: null,
  });
  if (error) throw dbError(error);
  forgetQuo(companyId);
}

async function current(admin: Db, companyId: string): Promise<QuoSettings | null> {
  const { data } = await admin.from("integrations").select("status, settings").match({ company_id: companyId, provider: "quo" }).maybeSingle();
  return data && data.status !== "disconnected" ? quoSettings(data.settings) : null;
}

/** Practice mode: Quo without a Quo account. Texts don't leave Crewtavo; replies are pretended. */
quo.put("/apps/quo/practice", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ test_numbers: numbers }));
  const settings: QuoSettings = { practice: true, test_only: true, test_numbers: testNumbers(body.test_numbers), lines: PRACTICE_LINES, webhook_id: null };
  await save(c.env, c.var.companyId, c.var.userId, settings, "Practice mode (no Quo account)");
  return c.json({ quo: quoState(appUrl(c), c.var.companyId, { status: "connected", settings }) });
});

/** The workspace's lines, to pick one per brand. The key is checked with Quo (free) and not kept. */
quo.post("/apps/quo/lines", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ api_key: z.string().trim().max(300).optional() }));
  const key = body.api_key || (await companyQuo(c.env, c.var.companyId))?.apiKey;
  if (!key) throw new HttpError(400, "Paste your Quo API key.");
  try {
    return c.json({ lines: await quoLines(key) });
  } catch (error) {
    if (error instanceof QuoProblem) throw new HttpError(400, error.message);
    throw error;
  }
});

/**
 * Connects the business's Quo workspace: its API key (checked with Quo, kept encrypted, never
 * returned) and the line each brand texts from. Test only stays on. Leaving the key out keeps the
 * one already saved, to change the lines.
 */
quo.put("/apps/quo/account", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(
    c,
    z.object({
      api_key: z.string().trim().max(300).regex(/^\S*$/, "Paste the key without spaces.").optional(),
      washing_line_id: z.string().trim().max(60).nullable(),
      lights_line_id: z.string().trim().max(60).nullable(),
      // Left out when changing the connection: the test numbers stay as they are (Test numbers changes them).
      test_numbers: numbers.optional(),
    }),
  );
  const admin = adminClient(c.env);
  const before = await current(admin, c.var.companyId);
  const kept = await loadSecret(c.env, admin, c.var.companyId, "quo").catch(() => null);
  const key = body.api_key || kept?.api_key;
  if (!key) throw new HttpError(400, "Paste your Quo API key.");
  let lines: QuoLine[];
  try {
    lines = await quoLines(key);
  } catch (error) {
    if (error instanceof QuoProblem) throw new HttpError(400, error.message);
    throw error;
  }
  const pick = (id: string | null) => {
    if (!id) return undefined;
    const line = lines.find((l) => l.id === id);
    if (!line) throw new HttpError(400, "That line isn't in this Quo workspace anymore. Pick it again.");
    return line;
  };
  const washing = pick(body.washing_line_id);
  const lights = pick(body.lights_line_id);
  if (!washing && !lights) throw new HttpError(400, "Pick the line texts go from.");
  // A new key is another workspace: the old webhook (and its signing key) were the old one's.
  const sameKey = !body.api_key || body.api_key === kept?.api_key;
  const settings: QuoSettings = {
    practice: false,
    test_only: before?.test_only ?? true,
    test_numbers: body.test_numbers === undefined ? (before?.test_numbers ?? []) : testNumbers(body.test_numbers),
    lines: { ...(washing ? { washing } : {}), ...(lights ? { lights } : {}) },
    webhook_id: sameKey && !before?.practice ? (before?.webhook_id ?? null) : null,
  };
  await saveSecret(c.env, admin, c.var.companyId, "quo", { api_key: key, extra: sameKey && kept?.extra?.webhook_key ? { webhook_key: kept.extra.webhook_key } : {} });
  await save(c.env, c.var.companyId, c.var.userId, settings, [washing?.name, lights?.name].filter(Boolean).join(" · ") || "Quo");
  return c.json({ quo: quoState(appUrl(c), c.var.companyId, { status: "connected", settings }) });
});

/** The test numbers: the only ones texted, and the only ones whose texts are kept, while it's test only. */
quo.put("/apps/quo/test-numbers", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ test_numbers: numbers }));
  const admin = adminClient(c.env);
  const before = await current(admin, c.var.companyId);
  if (!before) throw new HttpError(409, "Set up Quo first.");
  const settings = { ...before, test_numbers: testNumbers(body.test_numbers) };
  const { error } = await admin.from("integrations").update({ settings: asJson(settings) }).match({ company_id: c.var.companyId, provider: "quo" });
  if (error) throw dbError(error);
  forgetQuo(c.var.companyId);
  return c.json({ quo: quoState(appUrl(c), c.var.companyId, { status: "connected", settings }) });
});

/**
 * Asks Quo to post the lines' incoming texts here (a webhook in the Quo workspace, labelled
 * "Crewtavo (test)"). Only when asked. While it's test only, texts from numbers that aren't test
 * numbers are dropped as they arrive and never kept.
 */
quo.post("/apps/quo/webhook", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const base = appUrl(c);
  if (!base.startsWith("https://")) throw new HttpError(400, "Quo can only reach a public https address, and this Crewtavo doesn't have one yet.");
  const admin = adminClient(c.env);
  const settings = await current(admin, c.var.companyId);
  const kept = await loadSecret(c.env, admin, c.var.companyId, "quo").catch(() => null);
  if (!settings || settings.practice || !kept?.api_key) throw new HttpError(409, "Connect your Quo account first.");
  if (settings.webhook_id) return c.json({ quo: quoState(base, c.var.companyId, { status: "connected", settings }) });
  let made;
  try {
    made = await createQuoWebhook(kept.api_key, quoWebhookUrl(base, c.var.companyId), Object.values(settings.lines).map((l) => l!.id));
  } catch (error) {
    if (error instanceof QuoProblem) throw new HttpError(502, error.message);
    throw error;
  }
  await saveSecret(c.env, admin, c.var.companyId, "quo", { api_key: kept.api_key, extra: { webhook_key: made.key } });
  const next = { ...settings, webhook_id: made.id };
  const { error } = await admin.from("integrations").update({ settings: asJson(next) }).match({ company_id: c.var.companyId, provider: "quo" });
  if (error) throw dbError(error);
  forgetQuo(c.var.companyId);
  return c.json({ quo: quoState(base, c.var.companyId, { status: "connected", settings: next }) });
});

/**
 * A text that came in through Quo, filed as any incoming text is (services/inboundTexts.ts: on the
 * client's timeline, or under Unknown numbers, with STOP honoured). While it's test only, a text
 * from a number that isn't a test number is dropped here and never kept. Whether it was filed.
 */
export async function receiveQuoText(admin: Db, companyId: string, settings: Pick<QuoSettings, "test_only" | "test_numbers">, text: QuoIncomingText): Promise<boolean> {
  if (!quoNumberAllowed(settings, text.from)) return false;
  const body = text.text.slice(0, 10_000);
  if (!body.trim()) return false;
  const word = smsKeyword(body);
  const phrase = !word && asksToStopTexts(body);
  await receiveText(admin, { from: text.from, body, sid: text.id || null, keyword: phrase ? "stop" : word, phrase }, [companyId]);
  return true;
}

/** Test only: a test number "texts" the line, to try replies without a phone. */
quo.post("/apps/quo/pretend", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ from: z.string().trim().min(7).max(40), body: z.string().trim().min(1, "Type what they texted.").max(1600) }));
  const account = await companyQuo(c.env, c.var.companyId);
  if (!account) throw new HttpError(409, "Set up Quo first.");
  if (!account.settings.test_only) throw new HttpError(400, "Pretend texts are only for testing.");
  const [from] = testNumbers([body.from]);
  if (!quoNumberAllowed(account.settings, from)) throw new HttpError(400, "That isn't one of your test numbers.");
  await receiveQuoText(adminClient(c.env), c.var.companyId, account.settings, { id: `pretend-${crypto.randomUUID()}`, from: from!, text: body.body, phoneNumberId: null });
  kickAutomations(c, c.var.companyId);
  return c.json({ ok: true });
});

/**
 * Quo posts incoming texts here (the webhook /apps/quo/webhook made). Signed with the key Quo gave
 * for it; anything else is refused. Answered 200 even when the text is dropped, so Quo doesn't retry.
 */
quo.post("/webhooks/quo/:company", async (c) => {
  const companyId = c.req.param("company");
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) throw new HttpError(404, "Not found.");
  const raw = await c.req.text();
  const account = await companyQuo(c.env, companyId).catch(() => null);
  if (!account?.webhookKey || account.settings.practice) throw new HttpError(404, "Not found.");
  const signed = await quoSigned(account.webhookKey, { id: c.req.header("webhook-id"), timestamp: c.req.header("webhook-timestamp"), signature: c.req.header("webhook-signature") }, raw);
  if (!signed) throw new HttpError(403, "Bad signature.");
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ ok: true });
  }
  const text = quoIncomingText(event);
  if (text && (await receiveQuoText(adminClient(c.env), companyId, account.settings, text))) kickAutomations(c, companyId);
  return c.json({ ok: true });
});
