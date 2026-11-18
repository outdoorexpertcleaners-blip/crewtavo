/**
 * Sequences (services/sequences.ts): a follow-up ends as soon as its quote is answered, and a lead's
 * texts as soon as the lead moves on, not at the run's next step. Others keep going.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "../src/lib/supabase";
import { endAnswered } from "../src/services/sequences";
import { memoryClient, memoryDb } from "./fixtures/memoryDb";

const CO = "00000000-0000-0000-0000-0000000000c0";
const run = (id: string, sequence: string, type: string, subject: string, status = "active") => ({ id, company_id: CO, sequence_id: sequence, subject_type: type, subject_id: subject, step: 1, status, log: [] });

describe("ending runs whose record moved on", () => {
  it("stops follow-ups for answered quotes and texts for leads that moved on, and leaves the rest", async () => {
    const db = memoryDb({
      sequences: [{ id: "followup", trigger: "quote.sent" }, { id: "dialing", trigger: "request.created" }, { id: "review", trigger: "job.completed" }],
      quotes: [{ id: "q-approved", status: "approved" }, { id: "q-open", status: "sent" }],
      requests: [{ id: "r-moved", status: "new", stage: "hot" }, { id: "r-new", status: "new", stage: "inbound" }],
      sequence_runs: [
        run("1", "followup", "quote", "q-approved"),
        run("2", "followup", "quote", "q-open"),
        run("3", "followup", "quote", "q-approved", "paused"),
        run("4", "dialing", "request", "r-moved"),
        run("5", "dialing", "request", "r-new"),
        run("6", "review", "job", "j-1"),
        run("7", "followup", "quote", "q-approved", "done"),
      ],
    });
    const ended = await endAnswered(memoryClient(db) as unknown as Db, new Date("2026-11-18T20:00:00Z"));
    expect(ended).toBe(3);
    const status = Object.fromEntries(db.tables.sequence_runs!.map((r) => [r.id, r.status]));
    expect(status).toEqual({ 1: "stopped", 2: "active", 3: "stopped", 4: "stopped", 5: "active", 6: "active", 7: "done" });
    expect(db.tables.sequence_runs!.find((r) => r.id === "1")).toMatchObject({ ended_reason: "The quote was answered", log: [{ note: "The quote was answered" }] });
    expect(db.tables.sequence_runs!.find((r) => r.id === "4")!.ended_reason).toBe("The lead was moved past Inbound Lead");
  });

  it("stops a run whose quote was deleted", async () => {
    const db = memoryDb({ sequences: [{ id: "followup", trigger: "quote.sent" }], quotes: [], requests: [], sequence_runs: [run("1", "followup", "quote", "gone")] });
    expect(await endAnswered(memoryClient(db) as unknown as Db, new Date())).toBe(1);
    expect(db.tables.sequence_runs![0]).toMatchObject({ status: "stopped", ended_reason: "The record was deleted" });
  });
});
