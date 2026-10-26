import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "./fixtures";

// Screen 4 over the real bridge and the mock registry from @getdonn/registry-api. The browser
// sign-in is driven for real: the daemon runs `donn login <url>` as a job, which "opens the
// browser" through the `open`/`xdg-open` shims in e2e/bin (they record the URL, never open
// anything); the test then finishes that login at the mock registry with its `completeLogin`
// hook, as the person confirming the code would. One home per worker: the tests share a
// sign-in, so they run in order.

test.describe.configure({ mode: "serial" });

test("not signed in: the page offers sign-in", async ({ page, signIn }) => {
  await page.goto(signIn);
  await page.getByRole("link", { name: "Registry" }).click();
  await expect(page.getByRole("heading", { name: "Registry" })).toBeVisible();
  await expect(page.getByText("Not signed in")).toBeVisible();
});

test("signing in through the browser flow shows who you are and your roles", async ({
  page,
  signIn,
  donn,
}) => {
  donn.registry.grant("user:alice@corp.com", "publish", "*");
  donn.registry.grant("user:alice@corp.com", "lock", "*");
  await page.goto(signIn);
  await page.getByRole("link", { name: "Registry" }).click();
  await page
    .getByRole("textbox", { name: "Registry URL" })
    .fill(donn.registry.url);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Waiting for sign-in")).toBeVisible();
  // The daemon "opened the browser": the shim recorded the link the CLI printed.
  await expect
    .poll(() => donn.opened().at(-1) ?? "")
    .toMatch(new RegExp(`^${donn.registry.url}/login/`));
  // The link and code are on the page too, for a browser that did not open.
  await expect(page.getByText(donn.opened().at(-1)!)).toBeVisible();
  donn.registry.completeLogin(donn.opened().at(-1)!, {
    email: "alice@corp.com",
  });
  await expect(page.getByText("Signed in as alice@corp.com")).toBeVisible({
    timeout: 15_000,
  });
  const roles = page.getByRole("table", { name: "Roles" });
  await expect(roles.getByRole("row", { name: /publish/ })).toBeVisible();
  await expect(roles.getByRole("row", { name: /lock/ })).toBeVisible();
});

test("a refused dry run is shown, not a dialog", async ({ page, signIn }) => {
  await page.goto(signIn);
  await page.getByRole("link", { name: "Registry" }).click();
  await page.getByRole("combobox", { name: "Layer to publish" }).click();
  await page.getByRole("option", { name: "area/fintech" }).click();
  await page.getByRole("button", { name: "Review publish" }).click();
  // The registry wants a layer's ancestors published first.
  await expect(page.getByRole("alert")).toContainText("unpublished-ancestor");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("publish confirms the dry run first, then publishes", async ({
  page,
  signIn,
  donn,
}) => {
  await page.goto(signIn);
  await page.getByRole("link", { name: "Registry" }).click();
  await page.getByRole("combobox", { name: "Layer to publish" }).click();
  await page.getByRole("option", { name: "org/base" }).click();
  await page.getByRole("button", { name: "Review publish" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish org/base?" });
  // What --dry-run reports (a first publish has nothing to compare), nothing stored yet.
  await expect(dialog).toContainText("Dry run reports no changes");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Published org/base")).toHaveCount(0);
  await page.getByRole("button", { name: "Review publish" }).click();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Published org/base @1")).toBeVisible();
  // An edit to the local layer: the dry run lists it and the lock it touches.
  const file = `${donn.personas}/org/base.yaml`;
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      '    - "Read(./.env)"\n',
      '    - "Read(./.env)"\n    - "Bash(sudo:*)"\n',
    ),
  );
  await page.getByRole("button", { name: "Review publish" }).click();
  await expect(dialog.getByRole("list", { name: "Changes" })).toContainText(
    "permissions.deny",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("pull lists what changed", async ({ page, signIn, donn }) => {
  // Someone else publishes area/fintech (org/base is up by now); this home does not have it yet.
  const source = readFileSync(`${donn.personas}/area/fintech.yaml`, "utf8");
  const res = await fetch(
    `${donn.registry.url}/v1/layers/area%2Ffintech/versions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${donn.registry.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ source, files: [], baseVersion: 0 }),
    },
  );
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  await page.goto(signIn);
  await page.getByRole("link", { name: "Registry" }).click();
  await page.getByRole("button", { name: "Pull" }).click();
  await expect(page.getByRole("list", { name: "Pulled" })).toContainText(
    "area/fintech",
  );
});

test("signing out returns to the sign-in form", async ({ page, signIn }) => {
  await page.goto(signIn);
  await page.getByRole("link", { name: "Registry" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Not signed in")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Registry URL" }),
  ).toBeVisible();
});
