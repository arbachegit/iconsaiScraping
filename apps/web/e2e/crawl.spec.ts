import { test, expect } from '@playwright/test';
import { setupGuards } from './helpers/consoleNetworkGuards';
import { discoverLinks, getInteractiveElements } from './helpers/discovery';
import { safeClick, safeFill, generateSyntheticData } from './helpers/actions';

const MAX_PAGES = parseInt(process.env.E2E_MAX_PAGES || '20');
const MAX_ACTIONS = parseInt(process.env.E2E_MAX_ACTIONS_PER_PAGE || '15');

interface CoverageReport {
  pagesVisited: string[];
  actionsExecuted: number;
  elementsInteracted: number;
  errors: { category: string; message: string; url: string }[];
}

test.describe('Crawler - Massive UI Testing', () => {
  test('crawl all discoverable pages', async ({ page }) => {
    const coverage: CoverageReport = {
      pagesVisited: [],
      actionsExecuted: 0,
      elementsInteracted: 0,
      errors: [],
    };

    const visited = new Set<string>();
    const toVisit: string[] = ['/', '/dashboard'];
    const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3002';

    // Set fake auth to access protected pages
    await page.addInitScript(() => {
      localStorage.setItem('token', 'test-token');
    });

    while (toVisit.length > 0 && coverage.pagesVisited.length < MAX_PAGES) {
      const currentPath = toVisit.shift()!;

      if (visited.has(currentPath)) continue;
      visited.add(currentPath);

      const guards = setupGuards(page);

      try {
        await page.goto(currentPath, { waitUntil: 'networkidle' });
        coverage.pagesVisited.push(currentPath);

        // Verify page loaded
        await expect(page.locator('body')).toBeVisible();

        // Discover new links
        const links = await discoverLinks(page, baseURL);
        for (const link of links) {
          if (!visited.has(link) && !toVisit.includes(link)) {
            toVisit.push(link);
          }
        }

        // Get interactive elements
        const elements = await getInteractiveElements(page);
        let actionsOnPage = 0;

        for (const el of elements.slice(0, MAX_ACTIONS)) {
          if (el.isDestructive) {
            console.log(`[SKIP] Destructive action: ${el.text}`);
            continue;
          }

          // Skip logout/exit actions
          if (/logout|sair|exit/i.test(el.text)) {
            continue;
          }

          actionsOnPage++;
          coverage.elementsInteracted++;

          if (el.tag === 'input' || el.tag === 'textarea') {
            const value = generateSyntheticData(el.type || 'text');
            await safeFill(page, el.selector, value);
          } else if (el.tag === 'select') {
            // Try to select first option
            try {
              const options = await page
                .locator(`${el.selector} option`)
                .all();
              if (options.length > 1) {
                await page.selectOption(el.selector, { index: 1 });
              }
            } catch {
              // Ignore select errors
            }
          }

          coverage.actionsExecuted++;
        }

        // Check for errors after interactions
        if (guards.pageErrors.length > 0) {
          coverage.errors.push({
            category: 'UNHANDLED_PAGE_ERROR',
            message: guards.pageErrors.join('; '),
            url: currentPath,
          });
        }

        const serverErrors = guards.serverErrors.filter((e) => e.status >= 500);
        for (const err of serverErrors) {
          coverage.errors.push({
            category: 'NETWORK_5XX',
            message: `${err.status} on ${err.url}`,
            url: currentPath,
          });
        }

        // Log progress
        console.log(
          `[CRAWL] ${currentPath} - ${actionsOnPage} actions, ${guards.serverErrors.length} errors`
        );
      } catch (error) {
        coverage.errors.push({
          category: 'NAVIGATION_BROKEN',
          message: error instanceof Error ? error.message : String(error),
          url: currentPath,
        });
      }
    }

    // Final report
    console.log('\n================================================================================');
    console.log('                         CRAWLER COVERAGE REPORT');
    console.log('================================================================================');
    console.log(`Pages visited: ${coverage.pagesVisited.length}`);
    console.log(`Actions executed: ${coverage.actionsExecuted}`);
    console.log(`Elements interacted: ${coverage.elementsInteracted}`);
    console.log(`Errors found: ${coverage.errors.length}`);
    console.log('');
    console.log('Pages:');
    coverage.pagesVisited.forEach((p) => console.log(`  - ${p}`));

    if (coverage.errors.length > 0) {
      console.log('\nERRORS:');
      for (const err of coverage.errors) {
        console.log(`  [${err.category}] ${err.url}: ${err.message}`);
      }
    }
    console.log('================================================================================');

    // Fail if there are critical errors (5xx or page errors)
    const criticalErrors = coverage.errors.filter(
      (e) =>
        e.category === 'NETWORK_5XX' || e.category === 'UNHANDLED_PAGE_ERROR'
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('modal interactions', async ({ page }) => {
    const guards = setupGuards(page);

    await page.addInitScript(() => {
      localStorage.setItem('token', 'test-token');
    });

    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // Find clickable cards (module triggers)
    const cards = page.locator('[class*="cursor-pointer"]');
    const cardCount = await cards.count();

    console.log(`Found ${cardCount} clickable cards`);

    for (let i = 0; i < Math.min(cardCount, 4); i++) {
      const card = cards.nth(i);
      const cardText = await card.textContent();

      try {
        await card.click();
        await page.waitForTimeout(500);

        // Check for modal
        const modal = page.locator(
          '[class*="fixed"][class*="inset"], [role="dialog"]'
        );
        if ((await modal.count()) > 0) {
          console.log(`[MODAL] Opened: ${cardText?.trim().slice(0, 30)}`);

          // Try interactions inside modal
          const modalInputs = await modal.locator('input:visible').all();
          for (const input of modalInputs.slice(0, 3)) {
            const type = (await input.getAttribute('type')) || 'text';
            await input.fill(generateSyntheticData(type)).catch(() => {});
          }

          // Close modal
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }
      } catch (error) {
        console.log(`[ERROR] Card interaction failed: ${error}`);
      }
    }

    // Allow auth errors since we use fake token
    const criticalErrors = guards.serverErrors.filter((e) => e.status >= 500);
    expect(criticalErrors).toHaveLength(0);
  });
});
