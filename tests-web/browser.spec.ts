import { localDay } from "../shared/model";
import { totpAt } from "../worker/auth";
import { expect, test, type Page } from "@playwright/test";
test.beforeEach(async ({ page }, info) => {
  // Distinct simulated edge IP per test; production Cloudflare overwrites this header.
  await page.context().setExtraHTTPHeaders({
    "CF-Connecting-IP": `${info.project.name}:${info.title}`,
  });
});

test("create, prescribe, arrange, log, and revisit a workout on desktop and mobile", async ({
  page,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const exercise = `Bench ${suffix}`;
  const workout = `Push ${suffix}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  if (testInfo.project.name === "mobile") {
    const password = page.getByLabel("Password", { exact: true });
    await password.focus();
    expect(
      await password.evaluate((el) =>
        parseFloat(getComputedStyle(el).fontSize),
      ),
    ).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  }
  await page.getByLabel("Username", { exact: true }).fill("browser-test-user");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-password");
  const step =
    Math.floor(Date.now() / 30000) +
    (testInfo.project.name === "mobile" ? 1 : 0);
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(await totpAt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", step));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your workout journal" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "My library", exact: true }).click();
  await page.getByRole("button", { name: "New exercise", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Exercise name", { exact: true }).fill(exercise);
  await dialog.getByLabel("Muscle group", { exact: true }).fill("Chest");
  await dialog.getByLabel("Equipment", { exact: true }).fill("Barbell");
  await dialog.getByLabel("Effective from", { exact: true }).fill("2026-01-01");
  await dialog.getByLabel("Weight (kg)", { exact: true }).fill("60.125");
  await dialog
    .getByRole("button", { name: "Create exercise", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const exerciseLink = page.getByRole("button", {
    name: exercise,
    exact: true,
  });
  await expect(exerciseLink).toBeVisible();
  expect(
    await exerciseLink.evaluate(
      (el) => getComputedStyle(el).textDecorationLine,
    ),
  ).toContain("underline");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await exerciseLink.click();
  await expect(
    dialog.getByRole("heading", { name: exercise, exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Muscle group", { exact: true }),
  ).not.toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Exercise details", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("region", { name: "Exercise information" }),
  ).toHaveText("Chest · Barbell");
  const information = await dialog
    .getByRole("region", { name: "Exercise information" })
    .boundingBox();
  const memberships = await dialog
    .getByRole("region", { name: "Exercise workouts" })
    .boundingBox();
  expect(information!.y + information!.height).toBeLessThan(memberships!.y);
  await dialog.getByText("Edit exercise details", { exact: true }).click();
  await expect(dialog.getByLabel("Equipment", { exact: true })).toHaveValue(
    "Barbell",
  );
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Keep your shoulders steady.");
  await dialog
    .getByRole("button", { name: "Save details", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText(
    "Exercise details saved.",
  );
  await expect(
    dialog.getByRole("region", { name: "Exercise information" }),
  ).toContainText("Keep your shoulders steady.");
  for (const label of ["Muscle group", "Equipment", "Description"])
    await dialog.getByLabel(label, { exact: true }).fill("");
  await dialog
    .getByRole("button", { name: "Save details", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Exercise information" }),
  ).toHaveCount(0);
  await dialog.getByLabel("Equipment", { exact: true }).fill("Barbell");
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Keep your shoulders steady.");
  await dialog
    .getByRole("button", { name: "Save details", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Exercise information" }),
  ).toHaveText("BarbellKeep your shoulders steady.");

  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "New workout", exact: true }).click();
  await dialog.getByLabel("Workout name", { exact: true }).fill(workout);
  await dialog
    .getByRole("button", { name: "Create workout", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: `Edit ${workout}`, exact: true })
    .click();
  await dialog
    .getByLabel("Apply changes from", { exact: true })
    .fill("2026-01-01");
  await dialog
    .getByLabel("Add an exercise", { exact: true })
    .selectOption({ label: exercise });
  await page.route("**/api/actions", (route) => route.abort("failed"), {
    times: 1,
  });
  await dialog
    .getByRole("button", { name: "Save exercises", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Your changes may have been saved.",
  );
  await expect(dialog.getByRole("listitem")).toContainText(exercise);
  await expect(
    dialog.getByRole("button", { name: "Save exercises", exact: true }),
  ).toBeEnabled();
  // A confirmed save followed by a failed read must not be reported as a failed save.
  await page.route("**/api/data", (route) => route.abort("failed"), {
    times: 1,
  });
  await dialog
    .getByRole("button", { name: "Save exercises", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Your changes were saved, but the updated data could not be loaded.",
  );
  await expect(dialog.getByRole("listitem")).toContainText(exercise);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your workout journal" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Workout journal", exact: true })
    .click();
  await page.getByLabel("Workout date", { exact: true }).fill("2026-01-15");
  await page
    .getByRole("button", { name: "Set session date to today", exact: true })
    .click();
  expect(
    await page.getByLabel("Workout date", { exact: true }).inputValue(),
  ).toBe(localDay());
  await page.getByLabel("Workout date", { exact: true }).fill("2026-01-15");
  await page
    .getByLabel("Choose a workout", { exact: true })
    .selectOption({ label: workout });
  await expect(
    page.getByRole("cell", { name: "60.125 kg", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Session notes", { exact: false })
    .fill("Browser test session");
  await page.getByRole("button", { name: "Log workout", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Already logged", exact: true }),
  ).toBeDisabled();
  const calendar = page.getByRole("region", { name: "Workout calendar" });
  const legend = calendar.getByRole("list", {
    name: "Workouts logged this month",
  });
  await expect(legend.getByText(workout, { exact: true })).toBeVisible();
  await calendar.getByRole("button", { name: "Next month" }).click();
  await expect(legend.getByText(workout, { exact: true })).toHaveCount(0);
  await calendar.getByRole("button", { name: "Previous month" }).click();
  await expect(legend.getByText(workout, { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Most recent workout" })
      .getByText(workout, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Edit ${exercise}`, exact: true })
    .click();
  await expect(
    dialog.getByLabel("Description", { exact: true }),
  ).not.toBeVisible();
  await expect(
    dialog.getByRole("region", { name: "Exercise information" }),
  ).toContainText("Keep your shoulders steady.");
  await dialog.getByLabel("Effective from", { exact: true }).fill("2026-03-01");
  if (testInfo.project.name === "mobile") {
    const originalViewport = page.viewportSize()!;
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: originalViewport.height });
      const dateBox = (await dialog
        .getByLabel("Effective from", { exact: true })
        .boundingBox())!;
      const previous = (await dialog
        .getByRole("button", { name: "Previous effective day" })
        .boundingBox())!;
      const next = (await dialog
        .getByRole("button", { name: "Next effective day" })
        .boundingBox())!;
      const panel = (await dialog.boundingBox())!;
      expect(dateBox.x + dateBox.width + 4).toBeLessThanOrEqual(previous.x);
      expect(previous.x + previous.width + 4).toBeLessThanOrEqual(next.x);
      expect(next.x + next.width).toBeLessThanOrEqual(panel.x + panel.width);
    }
    await page.screenshot({
      path: "test-results/mobile-prescription.png",
      fullPage: true,
    });
    await page.setViewportSize(originalViewport);
  }
  await dialog.getByRole("button", { name: "Next effective day" }).click();
  await expect(
    dialog.getByLabel("Effective from", { exact: true }),
  ).toHaveValue("2026-03-02");
  await dialog.getByRole("button", { name: "Previous effective day" }).click();
  await expect(
    dialog.getByLabel("Effective from", { exact: true }),
  ).toHaveValue("2026-03-01");
  const weight = dialog.getByLabel("Weight (kg)", { exact: true });
  await weight.fill("63.125");
  await dialog
    .getByRole("button", { name: "Increase weight by 2.5 kg", exact: true })
    .click();
  await expect(weight).toHaveValue("65.625");
  await dialog
    .getByRole("button", { name: "Decrease weight by 2.5 kg", exact: true })
    .click();
  await expect(weight).toHaveValue("63.125");
  await weight.press("ArrowUp");
  await expect(weight).toHaveValue("65.625");
  await weight.press("ArrowDown");
  await expect(weight).toHaveValue("63.125");
  await dialog
    .getByRole("button", { name: "Save prescription", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-journal.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Session history", exact: true })
    .click();
  await page
    .getByLabel("Filter by workout", { exact: true })
    .selectOption({ label: workout });
  await page.getByRole("button", { name: new RegExp(workout) }).click();
  await expect(
    dialog.getByRole("cell", { name: "60.125 kg", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Browser test session", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Delete entry", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Delete entry", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "0 sessions", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Workout journal", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "Sign out", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  expect((await page.request.get("/api/data")).status()).toBe(401);
  expect(errors).toEqual([]);
});

const browserSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
async function signIn(
  page: Page,
  username: string,
  password = "browser-test-password",
  secret = browserSecret,
  offset = -1,
) {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(await totpAt(secret, Math.floor(Date.now() / 30000) + offset));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your workout journal" }),
  ).toBeVisible();
}
async function confirmAdmin(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Your password", { exact: true })
    .fill("browser-test-password");
  await dialog
    .getByLabel("Your authenticator code", { exact: true })
    .fill(await totpAt(browserSecret, Math.floor(Date.now() / 30000)));
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
test("invite a friend, enroll an authenticator, and keep their library private", async ({
  page,
  browser,
}, testInfo) => {
  const device = testInfo.project.name,
    username = `${device}-new-friend`;
  await signIn(page, `${device}-inviter`);
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page.getByRole("button", { name: "Create user", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Username", { exact: true })
    .fill(username);
  await confirmAdmin(page);
  const link = await page
    .getByLabel("Setup link", { exact: true })
    .inputValue();
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:8788",
    viewport: page.viewportSize()!,
  });
  const friend = await context.newPage();
  try {
    await friend.goto(link);
    await expect(
      friend.getByAltText("Authenticator setup QR code"),
    ).toBeVisible();
    expect(new URL(friend.url()).hash).toBe("");
    await friend
      .getByText("Enter a setup key manually", { exact: true })
      .click();
    const secret = (await friend.locator("code").textContent())!;
    await friend
      .getByLabel("New password", { exact: true })
      .fill("a-new-friend-password");
    await friend
      .getByLabel("Confirm password", { exact: true })
      .fill("a-new-friend-password");
    await friend
      .getByLabel("Authenticator code", { exact: true })
      .fill(await totpAt(secret, Math.floor(Date.now() / 30000)));
    await friend.getByRole("button", { name: "Complete setup" }).click();
    await expect(
      friend.getByRole("heading", { name: "Account ready" }),
    ).toBeVisible();
    await friend.getByRole("button", { name: "Go to sign in" }).click();
    await signIn(friend, username, "a-new-friend-password", secret, 1);
    await expect(
      friend.getByRole("button", { name: "Data manager", exact: true }),
    ).toHaveCount(0);
    await expect(
      friend.getByRole("button", { name: "Users", exact: true }),
    ).toHaveCount(0);
    await friend
      .getByRole("button", { name: "My library", exact: true })
      .click();
    await friend
      .getByRole("button", { name: "New workout", exact: true })
      .click();
    const dialog = friend.getByRole("dialog");
    await dialog
      .getByLabel("Workout name", { exact: true })
      .fill("Friend workout");
    await dialog
      .getByRole("button", { name: "Create workout", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole("button", { name: "Data manager", exact: true })
      .click();
    await expect(
      page.getByLabel("Database table", { exact: true }),
    ).toBeVisible();
    const options = await page
      .getByLabel("Record owner", { exact: true })
      .locator("option")
      .allTextContents();
    await page.getByLabel("Record owner", { exact: true }).selectOption({
      label: options.find((o) => o.startsWith(username + " ("))!,
    });
    await page
      .getByLabel("Database table", { exact: true })
      .selectOption("workout");
    await expect(page.locator('input[value="Friend workout"]')).toBeVisible();
    await page.getByRole("button", { name: "My library", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Friend workout", exact: true }),
    ).toHaveCount(0);
    expect(
      await friend.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const otherTab = await page.context().newPage();
    await otherTab.goto("/");
    await otherTab
      .getByRole("button", { name: "Data manager", exact: true })
      .click();
    await expect(
      otherTab.getByLabel("Database table", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Sign out", exact: true })
      .filter({ visible: true })
      .click();
    await expect(
      otherTab.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
    await expect(
      otherTab.getByLabel("Database table", { exact: true }),
    ).toHaveCount(0);
    await otherTab.close();
  } finally {
    await context.close();
  }
});

for (const kind of ["password", "recover"] as const) {
  test(`${kind} recovery requires setup before login`, async ({
    page,
    browser,
  }, testInfo) => {
    const device = testInfo.project.name,
      username = `${device}-${kind}-user`;
    await signIn(page, `${device}-${kind}-admin`);
    await page.getByRole("button", { name: "Users", exact: true }).click();
    // Use the shared card's direct parent to avoid selecting a list wrapper.
    const row = page.getByText(username, { exact: true }).locator("../..");
    await row
      .getByRole("button", {
        name: kind === "password" ? "Reset password" : "Recover account",
        exact: true,
      })
      .click();
    await confirmAdmin(page);
    const link = await page
      .getByLabel("Setup link", { exact: true })
      .inputValue();
    const context = await browser.newContext({
      baseURL: "http://127.0.0.1:8788",
      viewport: page.viewportSize()!,
    });
    const recovery = await context.newPage();
    try {
      await recovery.goto(link);
      await expect(
        recovery.getByLabel("New password", { exact: true }),
      ).toBeVisible();
      let secret = browserSecret;
      if (kind === "recover") {
        await expect(
          recovery.getByAltText("Authenticator setup QR code"),
        ).toBeVisible();
        await recovery
          .getByText("Enter a setup key manually", { exact: true })
          .click();
        secret = (await recovery.locator("code").textContent())!;
      } else
        await expect(
          recovery.getByAltText("Authenticator setup QR code"),
        ).toHaveCount(0);
      await recovery
        .getByLabel("New password", { exact: true })
        .fill("replacement-password");
      await recovery
        .getByLabel("Confirm password", { exact: true })
        .fill("replacement-password");
      await recovery
        .getByLabel("Authenticator code", { exact: true })
        .fill(await totpAt(secret, Math.floor(Date.now() / 30000)));
      await recovery.getByRole("button", { name: "Complete setup" }).click();
      await expect(
        recovery.getByRole("heading", { name: "Account ready" }),
      ).toBeVisible();
      await signIn(recovery, username, "replacement-password", secret, 1);
    } finally {
      await context.close();
    }
  });
}

test("delete a user with typed confirmation", async ({ page }, testInfo) => {
  const device = testInfo.project.name,
    username = `${device}-delete-user`;
  await signIn(page, `${device}-delete-admin`);
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page
    .getByText(username, { exact: true })
    .locator("../..")
    .getByRole("button", { name: "Delete user", exact: true })
    .click();
  await page
    .getByLabel(`Type ${username} to confirm`, { exact: true })
    .fill(username);
  await page.getByRole("checkbox").check();
  await confirmAdmin(page);
  await expect(page.getByText(username, { exact: true })).toHaveCount(0);
});
