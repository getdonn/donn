import { expect, test } from "./fixtures";

// The shell over the real bridge: sign-in, the five sections, the project picker with the
// seeded project, "Add project…", and the ended screen for a used code or a stale token.

const SECTIONS = ["Projects", "Sessions", "Capabilities", "Registry", "Agents"];

test("signs in, clears the code and renders the shell", async ({
  page,
  signIn,
}) => {
  // A CSP violation (an inline script, a font from elsewhere) is a console error.
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(signIn);
  const nav = page.getByRole("navigation", { name: "Sections" });
  for (const section of SECTIONS) {
    await expect(nav.getByRole("link", { name: section })).toBeVisible();
  }
  await expect(page).toHaveURL(/\/projects$/);
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("row", { name: /checkout-api/ })).toBeVisible();
  // The picked project's persona, from `donn resolve --json` parsed with its schema.
  const persona = page.getByLabel("Persona");
  await expect(persona).toContainText("checkout-api");
  await expect(persona).toContainText("team/payments");
  expect(errors).toEqual([]);
});

test("the picker lists the seeded project", async ({ page, signIn, donn }) => {
  await page.goto(signIn);
  const picker = page.getByRole("button", { name: "Project" });
  await expect(picker).toHaveText(/checkout-api/);
  await picker.click();
  await expect(
    page.getByRole("menuitemradio", { name: /checkout-api/ }),
  ).toContainText(donn.repo);
});

test("Add project… records a project and picks it", async ({
  page,
  signIn,
  donn,
}) => {
  await page.goto(signIn);
  await page.getByRole("button", { name: "Project" }).click();
  await page.getByRole("menuitem", { name: "Add project…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add project" });

  // A folder that is not a donn project is refused, with the CLI's fix.
  await dialog.getByLabel("Path").fill(donn.root);
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog.getByRole("alert")).toContainText("not a donn project");

  await dialog.getByLabel("Path").fill(donn.other);
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Project" })).toHaveText(
    /other-service/,
  );
  await page.getByRole("button", { name: "Project" }).click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
});

test("a used code shows the ended screen", async ({
  page,
  signIn,
  browser,
}) => {
  await page.goto(signIn);
  await expect(
    page.getByRole("navigation", { name: "Sections" }),
  ).toBeVisible();

  const again = await browser.newPage();
  await again.goto(signIn);
  await expect(again.getByTestId("session-ended")).toContainText(
    "Session ended — run donn ui again",
  );
  await again.close();
});

test("a stale token shows the ended screen", async ({ page, donn }) => {
  const base = new URL(donn.url()).origin;
  await page.addInitScript(() =>
    sessionStorage.setItem("donn.ui.token", "stale-token"),
  );
  await page.goto(`${base}/projects`);
  await expect(page.getByTestId("session-ended")).toContainText(
    "no longer accepts",
  );
});

test("a stopped daemon ends the session: the ended screen, no retrying", async ({
  page,
  signIn,
  donn,
}) => {
  await page.goto(signIn);
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  try {
    const stopped = donn.cli(["daemon", "stop"]);
    expect(stopped.status, stopped.stderr).toBe(0);
    const ended = page.getByTestId("session-ended");
    await expect(ended).toContainText("run donn ui again");
    await expect(ended).toContainText("The daemon stopped.");
    // Ended: the page asks for no more events.
    let asked = 0;
    page.on("request", (req) => {
      if (req.url().endsWith("/v1/events")) asked++;
    });
    await page.waitForTimeout(1_500);
    expect(asked).toBe(0);
  } finally {
    // The worker's later tests need it.
    const started = donn.cli(["daemon", "start"]);
    expect(started.status, started.stderr).toBe(0);
  }
});
