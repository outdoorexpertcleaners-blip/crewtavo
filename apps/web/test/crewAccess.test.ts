/**
 * Field crew ("Employee") in the app: their menus are My day, Schedule, Clock and Clients, with their
 * profile for Settings, on the sidebar and the phone's tab bar; any other screen opened by its
 * address sends them to My day; a visit opened from the whole team's schedule goes to the field
 * app's page, where on someone else's visit they only look; and a client's page is a lookup, without
 * the work sold to them. Every other level keeps what it had.
 */
import { ROLES, STAFF } from "@crewtavo/core/roles";
import { describe, expect, it } from "vitest";
import {
  canOpen, CREW_TABS, crewCanOpen, homePath, MOBILE_TABS, mobileTabs, NAV_GROUPS, navVisible, OTHER_SCREENS, SETTINGS_ITEM, settingsItem, SUB_TABS,
} from "../src/components/shell/nav";
import { lookupOnly } from "../src/features/clients/access";
import { onlyLooking } from "../src/features/field/visitAccess";
import { opensInField } from "../src/features/schedule/myCrews";
import { profileOnly, settingsGroups } from "../src/features/settings/sections";
import type { Session } from "../src/lib/session";

/** Every app the business can turn on, on: field crew's menus don't grow with them. */
const EVERYTHING = { team_chat: { enabled: true }, website: { enabled: true }, careers: { enabled: true }, drive: { enabled: true }, marketing: { enabled: true }, paving_app: { enabled: true }, roofing_app: { enabled: true }, snow_app: { enabled: true } };
const person = (role: string, permissions: string[] = [], settings: Record<string, unknown> = EVERYTHING) => ({ role, permissions, company: { settings } });
const EVERY_SCREEN = [...NAV_GROUPS.flat(), ...OTHER_SCREENS, SETTINGS_ITEM];
const shown = (role: string, permissions: string[] = []) => EVERY_SCREEN.filter((item) => navVisible(person(role, permissions), item)).map((item) => item.to);

describe("field crew's menus", () => {
  it("are My day, Schedule, Clock and Clients, whatever the business has turned on or their role allows", () => {
    expect(shown("field_crew")).toEqual(["/field", "/clock", "/schedule", "/clients"]);
    // Areas a custom role might list don't add screens either.
    expect(shown("field_crew", ["sales", "invoices", "reports", "timesheets", "equipment", "kb_edit"])).toEqual(["/field", "/clock", "/schedule", "/clients"]);
  });

  it("have their profile in place of Settings", () => {
    expect(settingsItem({ role: "field_crew" })).toMatchObject({ to: "/settings?tab=profile", label: "Profile" });
    for (const role of ["owner", "admin", "office", "estimator", "crew_lead"]) expect(settingsItem({ role }), role).toBe(SETTINGS_ITEM);
  });

  it("give them their own tab bar on the phone: My day, Schedule, Clock and Clients", () => {
    expect(mobileTabs(person("field_crew")).map((t) => t.to)).toEqual(["/field", "/schedule", "/clock", "/clients"]);
    expect(mobileTabs(person("field_crew"))).toBe(CREW_TABS);
  });

  it("leave everyone else's tab bar as it was", () => {
    for (const role of ["owner", "admin", "office", "estimator", "crew_lead"]) {
      expect(mobileTabs(person(role)).map((t) => t.to), role).toEqual(MOBILE_TABS.map((t) => t.to));
      expect(mobileTabs(person(role, [], {})).map((t) => t.to), role).toEqual(["/", "/field", "/schedule", "/clients"]);
    }
    expect(mobileTabs(person("subcontractor"))).toBe(SUB_TABS);
  });

  it("put the Clock in front of crew leads too, and nobody else", () => {
    const clock = NAV_GROUPS.flat().find((item) => item.to === "/clock")!;
    expect(clock.icon).toBe("history");
    expect(ROLES.filter((role) => navVisible(person(role, ["timesheets"]), clock))).toEqual(["crew_lead", "field_crew"]);
  });

  it("leave the other levels' sidebars as they were", () => {
    // Crew leads keep Home, Requests, Jobs, Timesheets and the rest, and gain the Clock.
    expect(shown("crew_lead", ["schedule", "timesheets", "equipment"])).toEqual(expect.arrayContaining(["/", "/field", "/clock", "/schedule", "/requests", "/jobs", "/timesheets", "/equipment", "/kb"]));
    expect(shown("office", ["invoices", "reports"])).toEqual(expect.arrayContaining(["/", "/schedule", "/clients", "/messages", "/pipeline", "/quotes", "/invoices", "/finance", "/timesheets"]));
    expect(shown("office")).not.toContain("/clock");
  });
});

describe("screens field crew can open by their address", () => {
  it("are My day and any visit, the schedule, the clock, the clients and a client, and Settings (their profile)", () => {
    for (const path of ["/field", "/field/", "/field/visits/0b8f1c1e-1a2b-4c3d-8e9f-001122334455", "/schedule", "/schedule/", "/clock", "/clients", "/clients/", "/clients/0b8f1c1e-1a2b-4c3d-8e9f-001122334455", "/settings"]) {
      expect(crewCanOpen(path), path).toBe(true);
      expect(canOpen({ role: "field_crew" }, path), path).toBe(true);
    }
  });

  it("aren't Home or anything internal: those go to My day", () => {
    for (const path of [
      "/", "/pipeline", "/workflows", "/workflows/1", "/messages", "/quotes", "/quotes/1", "/invoices", "/invoices/1", "/payouts", "/requests", "/requests/1",
      "/jobs", "/jobs/1", "/finance", "/metrics", "/marketing", "/apps", "/automations", "/booking", "/timesheets", "/equipment", "/kb", "/chat", "/drive", "/drive/trash",
      "/subs", "/applicants", "/measure", "/field/jobs", "/field/jobs/1", "/field/paperwork", "/clients/duplicates", "/clients/1/edit", "/settings/x", "/clockx", "/schedulex", "/roofing", "/snow",
    ]) {
      expect(crewCanOpen(path), path).toBe(false);
      expect(canOpen({ role: "field_crew" }, path), path).toBe(false);
    }
  });

  it("are every screen for the rest of the team, as before, and a sub's own list for a sub", () => {
    for (const role of ["owner", "admin", "office", "estimator", "crew_lead"]) {
      for (const path of ["/", "/pipeline", "/invoices/1", "/timesheets", "/clients/duplicates"]) expect(canOpen({ role }, path), `${role} ${path}`).toBe(true);
    }
    expect(canOpen({ role: "subcontractor" }, "/field/paperwork")).toBe(true);
    expect(canOpen({ role: "subcontractor" }, "/clients")).toBe(false);
  });

  it("start from My day: the logo takes field crew and subs there, everyone else Home", () => {
    expect(homePath({ role: "field_crew" })).toBe("/field");
    expect(homePath({ role: "subcontractor" })).toBe("/field");
    for (const role of ["owner", "admin", "office", "estimator", "crew_lead"]) expect(homePath({ role }), role).toBe("/");
  });
});

describe("field crew's settings", () => {
  const session = (role: string) => ({ role, permissions: [], config: { singleCompany: true, platform: "railway" } }) as unknown as Session;

  it("are only their own profile, like a sub's", () => {
    expect(settingsGroups(session("field_crew")).flatMap((g) => g.items.map((i) => ("tab" in i ? i.tab : i.to)))).toEqual(["profile"]);
    expect(STAFF.filter((role) => profileOnly({ role }))).toEqual(["field_crew"]);
    expect(profileOnly({ role: "subcontractor" })).toBe(true);
    expect(settingsGroups(session("crew_lead")).flatMap((g) => g.items.map((i) => ("tab" in i ? i.tab : i.to)))).toEqual(expect.arrayContaining(["profile", "assistants", "license"]));
  });
});

describe("the schedule and visits for field crew", () => {
  it("opens a visit in the field app for field crew, and the details for everyone else", () => {
    expect(ROLES.filter((role) => opensInField({ role }))).toEqual(["field_crew"]);
  });

  const me = { role: "field_crew", userId: "me" };
  it("lets them only look at a visit they're not on", () => {
    // Someone else listed: only looking, whatever the crew.
    expect(onlyLooking(me, { crew_id: "mowing", assignees: [{ user_id: "dee" }] }, ["mowing"])).toBe(true);
    // Another crew's visit with nobody listed, or a visit with no crew and nobody listed.
    expect(onlyLooking(me, { crew_id: "trees", assignees: [] }, ["mowing"])).toBe(true);
    expect(onlyLooking(me, { crew_id: null, assignees: [] }, [])).toBe(true);
  });

  it("lets them work a visit they're on: listed, or on its crew with nobody listed", () => {
    expect(onlyLooking(me, { crew_id: "trees", assignees: [{ user_id: "me" }] }, [])).toBe(false);
    expect(onlyLooking(me, { crew_id: "mowing", assignees: [] }, ["mowing"])).toBe(false);
  });

  it("never takes the buttons away while their crews load, or from anyone but field crew", () => {
    expect(onlyLooking(me, { crew_id: "trees", assignees: [{ user_id: "dee" }] }, undefined)).toBe(false);
    for (const role of ["owner", "admin", "office", "estimator", "crew_lead", "subcontractor"]) {
      expect(onlyLooking({ role, userId: "me" }, { crew_id: "trees", assignees: [{ user_id: "dee" }] }, []), role).toBe(false);
    }
  });
});

describe("a client's page for field crew", () => {
  it("is a lookup, without the requests, quotes and jobs sold to them", () => {
    expect(ROLES.filter((role) => lookupOnly({ role }))).toEqual(["field_crew"]);
  });
});
