import { rmSync, writeFileSync } from "node:fs";
import { expect, test } from "./fixtures";

// Screens 2 and 3 over the real bridge: live sessions from `status --json` (a seeded launch
// record whose process is the worker), switching with the spec 17 report, and the capability
// matrix with the current persona's compile reports.

test("a seeded session appears with its harness, project and persona", async ({
  page,
  signIn,
  donn,
}) => {
  donn.session({
    harness: "claude-code",
    persona: "team/payments",
    project: donn.repo,
  });
  await page.goto(signIn);
  await page.getByRole("link", { name: "Sessions" }).click();
  const row = page.getByRole("row", { name: /claude-code/ });
  await expect(row).toContainText("checkout-api");
  await expect(row).toContainText("team/payments");
});

test("a session started later appears without a reload", async ({
  page,
  signIn,
  donn,
}) => {
  await page.goto(signIn);
  await page.getByRole("link", { name: "Sessions" }).click();
  // Sessions of earlier tests stay (one home per worker): only codex is new.
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("row", { name: /codex/ })).toHaveCount(0);
  donn.session({
    harness: "codex",
    persona: "area/fintech",
    project: donn.repo,
  });
  const row = page.getByRole("row", { name: /codex/ });
  await expect(row).toContainText("area/fintech");
});

test("switching shows the report per harness", async ({
  page,
  signIn,
  donn,
}) => {
  donn.session({
    harness: "claude-code",
    persona: "team/payments",
    project: donn.repo,
  });
  await page.goto(signIn);
  await page.getByRole("link", { name: "Sessions" }).click();
  await page.getByRole("combobox", { name: "Switch to" }).click();
  await page.getByRole("option", { name: "area/fintech" }).click();
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Switched to area/fintech" });
  await expect(report).toContainText("claude-code");
  await expect(report).toContainText("codex");
  // The seeded session still runs team/payments.
  await expect(report).toContainText("team/payments");
  await expect(report).toContainText(/\d+ sessions? still on/);
});

test("the matrix has a row per harness, and compile reports for the project", async ({
  page,
  signIn,
}) => {
  await page.goto(signIn);
  await page.getByRole("link", { name: "Capabilities" }).click();
  const harnesses = page.getByRole("table", { name: "Harnesses" });
  await expect(
    harnesses.getByRole("row", { name: /claude-code/ }),
  ).toBeVisible();
  await expect(harnesses.getByRole("row", { name: /codex/ })).toBeVisible();
  const matrix = page.getByRole("table", { name: "Fields by harness" });
  await expect(matrix.getByRole("row", { name: /instructions/ })).toBeVisible();
  // agents-md is always installed: its report for this project is shown.
  await expect(
    page.getByRole("region", { name: "Compile report: agents-md" }),
  ).toBeVisible();
});

test("a failed switch is shown beside the buttons", async ({
  page,
  signIn,
  donn,
}) => {
  // A persona the list offers, removed before the switch: the CLI cannot find it.
  const ghost = `${donn.personas}/team/ghost.yaml`;
  writeFileSync(
    ghost,
    "apiVersion: donn/v0\nkind: Persona\nmetadata:\n  name: ghost\n  version: 1\n",
  );
  await page.goto(signIn);
  await page.getByRole("link", { name: "Sessions" }).click();
  await page.getByRole("combobox", { name: "Switch to" }).click();
  await page.getByRole("option", { name: "team/ghost" }).click();
  rmSync(ghost);
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("team/ghost");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the report says what AGENTS.md carries", async ({
  page,
  signIn,
  donn,
}) => {
  // The CLI reports agents-md only for a project whose AGENTS.md has a donn block.
  expect(donn.cli(["write", "--json"]).status).toBe(0);
  await page.goto(signIn);
  await page.getByRole("link", { name: "Sessions" }).click();
  await page.getByRole("combobox", { name: "Switch to" }).click();
  await page.getByRole("option", { name: "area/fintech" }).click();
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Switched to area/fintech" });
  await expect(report).toContainText("agents-md");
  await expect(report).toContainText(
    "AGENTS.md carries the project persona, not this switch.",
  );
});
