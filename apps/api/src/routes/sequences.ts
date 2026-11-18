/**
 * Sequences (services/sequences.ts): adding the business's GoHighLevel workflows from their
 * templates (core/sequences.ts SEQUENCE_TEMPLATES, turned off), the number the office's alerts are
 * texted to, and pausing, resuming or stopping one client's run. The sequences themselves are
 * edited straight in the database by the office (RLS: sequences_*).
 */
import { OFFICE } from "@crewtavo/core";
import { phoneE164 } from "@crewtavo/core/phone";
import { SEQUENCE_TEMPLATES } from "@crewtavo/core/sequences";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { asJson, dbError, HttpError, param, readJson } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { changeRun } from "../services/sequences";

export const sequences = new Hono<AppEnv>();

/** Adds the templates not added yet, turned off, so nothing runs until someone turns one on. */
sequences.post("/sequences/templates", requireUser, requireCompany(OFFICE), async (c) => {
  const admin = adminClient(c.env);
  const { data: have, error } = await admin.from("sequences").select("template_key").eq("company_id", c.var.companyId).not("template_key", "is", null);
  if (error) throw dbError(error);
  const had = new Set((have ?? []).map((r) => r.template_key));
  const add = SEQUENCE_TEMPLATES.filter((t) => !had.has(t.key));
  if (add.length) {
    const { error: insertError } = await admin.from("sequences").insert(
      add.map((t) => ({
        company_id: c.var.companyId, name: t.name, brand: t.brand, trigger: t.trigger, on_reply: t.on_reply, send_window: asJson(t.send_window), steps: asJson(t.steps),
        enabled: false, template_key: t.key, created_by: c.var.userId,
      })),
    );
    if (insertError) throw dbError(insertError);
  }
  return c.json({ added: add.length });
});

sequences.get("/sequences/alert-phone", requireUser, requireCompany(OFFICE), async (c) => {
  const { data, error } = await adminClient(c.env).from("companies").select("settings").eq("id", c.var.companyId).single();
  if (error) throw dbError(error);
  const phone = (data.settings as Record<string, unknown> | null)?.sequence_alert_phone;
  return c.json({ phone: typeof phone === "string" ? phone : null });
});

/** The number the office's alerts are texted to (a new lead, a reply). Empty: alerts in the app only. */
sequences.put("/sequences/alert-phone", requireUser, requireCompany(OFFICE), async (c) => {
  const body = await readJson(c, z.object({ phone: z.string().trim().max(40) }));
  const phone = body.phone ? phoneE164(body.phone) : null;
  if (body.phone && !phone) throw new HttpError(400, "Type the number with its area code, like (470) 555-0101.");
  const admin = adminClient(c.env);
  const { data: company, error } = await admin.from("companies").select("settings").eq("id", c.var.companyId).single();
  if (error) throw dbError(error);
  const settings = { ...((company.settings ?? {}) as Record<string, unknown>), sequence_alert_phone: phone };
  const { error: saveError } = await admin.from("companies").update({ settings: asJson(settings) }).eq("id", c.var.companyId);
  if (saveError) throw dbError(saveError);
  return c.json({ phone });
});

sequences.post("/sequence-runs/:id/:action", requireUser, requireCompany(OFFICE), async (c) => {
  const action = c.req.param("action");
  if (action !== "pause" && action !== "resume" && action !== "stop") throw new HttpError(404, "Not found.");
  const admin = adminClient(c.env);
  const { data: me } = await admin.from("profiles").select("full_name").eq("user_id", c.var.userId).maybeSingle();
  try {
    return c.json({ run: await changeRun(admin, c.var.companyId, param(c, "id"), action, me?.full_name || "the office") });
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
});
