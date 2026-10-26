import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { E2E_SECRET, expect, test } from "./fixtures";

// Screen 5, agents (docs/planning/26-gui.md §3): the list and the agent page over the real
// bridge. eve, Vercel and Docker are the PATH shims in e2e/bin (README.md there): `eve start`
// listens for real, `eve add` replays the CLI's recordings. The project persona declares bot
// (local), box (self-host) and cloud (vercel); box and cloud take `secret://env/E2E_SECRET`,
// whose value is in the daemon's environment and must never reach the page. One home per
// worker: the tests build on each other, so they run in order.

test.describe.configure({ mode: "serial" });

test.beforeAll(({ donn }) => {
  for (const name of ["box", "cloud"]) {
    const r = donn.cli(["agent", "create", name, "--json"]);
    expect(r.status, r.stderr).toBe(0);
  }
});

const row = (page: Page, name: string) =>
  page
    .getByRole("table", { name: "Agents" })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });

/** The agent page for `name`, from the list. */
async function agentPage(page: Page, signIn: string, name: string) {
  await page.goto(signIn);
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

const noSecret = async (page: Page) =>
  expect(await page.content()).not.toContain(E2E_SECRET);

test("the list shows each declared agent, and one created meanwhile", async ({
  page,
  signIn,
  donn,
}) => {
  await page.goto(signIn);
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(row(page, "bot")).toContainText("available");
  await expect(row(page, "box")).toContainText("self-host");
  await expect(row(page, "box")).toContainText("created");
  await expect(row(page, "cloud")).toContainText("vercel");
  // Created from a terminal: the daemon's agent.created refreshes the list.
  const r = donn.cli(["agent", "create", "bot", "--json"]);
  expect(r.status, r.stderr).toBe(0);
  await expect(row(page, "bot")).toContainText("created", { timeout: 15_000 });
  await expect(row(page, "bot")).toContainText("current");
});

test("run shows the agent running at its URL, its log, and stop stops it", async ({
  page,
  signIn,
}) => {
  await agentPage(page, signIn, "bot");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const url = page.getByRole("link", { name: /^http:\/\/127\.0\.0\.1:\d+\/$/ });
  await expect(url).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-state")).toHaveText("running");
  // The shim's server listens for real at that URL.
  const res = await fetch((await url.textContent())!);
  expect(res.ok).toBe(true);
  await expect(page.getByRole("region", { name: "Logs" })).toContainText(
    "[START] server listening",
  );
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByTestId("agent-state")).toHaveText("created");
  await expect(url).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Run", exact: true }),
  ).toBeEnabled();
});

test("an add job asks its multi-select question and completes once answered", async ({
  page,
  signIn,
  donn,
}) => {
  await agentPage(page, signIn, "bot");
  const add = page.getByRole("region", { name: "Add a channel or connection" });
  await add
    .getByRole("textbox", { name: "Registry item" })
    .fill("channel/github");
  await add.getByRole("button", { name: "Add" }).click();
  const question = add.getByRole("group", {
    name: "What should this GitHub App respond to?",
  });
  await expect(question).toBeVisible({ timeout: 15_000 });
  // eve's recommended options come checked.
  await expect(
    question.getByRole("checkbox", { name: /New issue and PR comments/ }),
  ).toBeChecked();
  await expect(
    question.getByRole("checkbox", { name: /New PRs/ }),
  ).not.toBeChecked();
  await question.getByRole("checkbox", { name: /New PRs/ }).check();
  await add.getByRole("button", { name: "Continue" }).click();
  await expect(add.getByRole("status")).toContainText("Added channel/github", {
    timeout: 15_000,
  });
  // eve got the boxes checked, as one JSON answer.
  const answers = JSON.parse(
    readFileSync(join(donn.repo, "agents/bot/.e2e-answers.json"), "utf8"),
  ) as string[];
  expect(answers).toEqual([
    'github-events=["issue_comment","pull_request_review_comment","pull_request"]',
  ]);
});

test("a secret question shows the variable to set, never a field", async ({
  page,
  signIn,
}) => {
  await agentPage(page, signIn, "bot");
  const add = page.getByRole("region", { name: "Add a channel or connection" });
  await add
    .getByRole("textbox", { name: "Registry item" })
    .fill("channel/secret");
  await add.getByRole("button", { name: "Add" }).click();
  const question = add.getByRole("group", { name: "Webhook secret" });
  await expect(question).toBeVisible({ timeout: 15_000 });
  await expect(question).toContainText("E2E_WEBHOOK_SECRET");
  await expect(question).toContainText("keychain");
  await expect(question.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(question.getByRole("textbox")).toHaveCount(0);
  await expect(add.getByRole("button", { name: "Continue" })).toHaveCount(0);
});

test("a prerequisite shows what to do first", async ({ page, signIn }) => {
  await agentPage(page, signIn, "bot");
  const add = page.getByRole("region", { name: "Add a channel or connection" });
  await add
    .getByRole("textbox", { name: "Registry item" })
    .fill("channel/linked");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(add).toContainText("requires a linked Vercel project", {
    timeout: 15_000,
  });
  await expect(add).toContainText("run eve link in agents/bot");
});

test("sync and open the agent's folder", async ({ page, signIn, donn }) => {
  await agentPage(page, signIn, "bot");
  await page.getByRole("button", { name: "Sync" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Synced/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open folder" }).click();
  await expect
    .poll(() =>
      existsSync(donn.editorLog) ? readFileSync(donn.editorLog, "utf8") : "",
    )
    .toContain(join(donn.repo, "agents/bot"));
});

test("self-host: build shows the Dockerfile and env.json with refs only", async ({
  page,
  signIn,
}) => {
  await agentPage(page, signIn, "box");
  await page.getByRole("button", { name: "Build" }).click();
  await expect(page.getByRole("region", { name: "Dockerfile" })).toContainText(
    "FROM node:26-slim",
    { timeout: 15_000 },
  );
  const env = page.getByRole("region", { name: "env.json" });
  await expect(env).toContainText("API_TOKEN");
  await expect(env).toContainText("secret://env/E2E_SECRET");
  await expect(page.getByTestId("agent-state")).toHaveText("built");
  await noSecret(page);
});

test("a run from the app refuses an env-provider secret with the CLI's fix", async ({
  page,
  signIn,
}) => {
  await agentPage(page, signIn, "box");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("no shell environment", {
    timeout: 15_000,
  });
  await expect(alert).toContainText("use the keychain provider");
  await noSecret(page);
});

test("vercel: deploy confirms the names it will push, then deploys", async ({
  page,
  signIn,
  donn,
}) => {
  await agentPage(page, signIn, "cloud");
  await expect(
    page.getByRole("button", { name: "Run", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Deploy…" }).click();
  const dialog = page.getByRole("dialog", { name: "Deploy cloud to Vercel?" });
  await expect(dialog.getByRole("list", { name: "Variables" })).toHaveText(
    "API_TOKEN",
  );
  await noSecret(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(existsSync(join(donn.repo, "agents/cloud/.vercel"))).toBe(false);

  await page.getByRole("button", { name: "Deploy…" }).click();
  await dialog.getByRole("button", { name: "Deploy", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Deployed" }),
  ).toContainText("https://e2e-agent.vercel.app", { timeout: 15_000 });
  await expect(page.getByTestId("agent-state")).toHaveText("deployed");
  await noSecret(page);
});
