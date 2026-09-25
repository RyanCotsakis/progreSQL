import { localDay } from "../shared/model";
import { totpAt } from "../worker/auth";
import { expect, test } from "@playwright/test";

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
  await dialog
    .getByRole("button", { name: "Save exercises", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
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
