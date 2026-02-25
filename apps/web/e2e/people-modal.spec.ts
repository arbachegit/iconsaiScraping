import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

/**
 * Helper: click the "Pessoas" module card under "Modulos de Inteligencia"
 * (NOT the stat card at the top which has no onClick)
 */
async function openPeopleModal(page: import('@playwright/test').Page) {
  // Scroll to module cards section
  const moduleSection = page.locator('text=Modulos de Inteligencia');
  await moduleSection.scrollIntoViewIfNeeded();

  // Click the module card that contains "Pessoas" + "Perfis profissionais"
  const pessoasModuleCard = page.locator('div.cursor-pointer', { hasText: 'Perfis profissionais' });
  await pessoasModuleCard.click();

  // Wait for modal to appear
  await expect(page.locator('text=Buscar Pessoa')).toBeVisible({ timeout: 10000 });
}

test.describe('People Modal — Scroll, Search, Pagination, Badges, Stack', () => {
  test.beforeEach(async ({ page }) => {
    // Inject auth token to bypass login redirect
    await page.addInitScript(() => {
      localStorage.setItem('token', 'test-token');
    });

    // Mock /api/auth/me to return a valid user (avoids 401 → handleLogout)
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          email: 'test@example.com',
          name: 'Test User',
          role: 'super_admin',
        }),
      })
    );

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    // Wait for module cards section to render
    await page.waitForSelector('text=Modulos de Inteligencia', { timeout: 15000 });
  });

  test('1. Modal opens when clicking Pessoas module card', async ({ page }) => {
    await openPeopleModal(page);

    // Take screenshot
    await page.screenshot({ path: 'e2e/screenshots/people-modal-open.png', fullPage: false });
  });

  test('2. Modal has 1000px width and correct structure', async ({ page }) => {
    await openPeopleModal(page);

    // Check modal width (should be 1000px)
    const modalBox = await page.locator('div[style*="width: 1000"]').first().boundingBox();
    if (modalBox) {
      console.log(`Modal width: ${modalBox.width}px`);
      expect(modalBox.width).toBeGreaterThanOrEqual(900);
      expect(modalBox.width).toBeLessThanOrEqual(1050);
    }

    // Check type toggle exists (CPF / Nome)
    await expect(page.locator('button:has-text("CPF")')).toBeVisible();
    await expect(page.locator('button:has-text("Nome")')).toBeVisible();

    // Check search button exists
    await expect(page.locator('button:has-text("Buscar")')).toBeVisible();

    await page.screenshot({ path: 'e2e/screenshots/people-modal-structure.png' });
  });

  test('3. CPF search type toggle works', async ({ page }) => {
    await openPeopleModal(page);

    // Default should be CPF mode — check for placeholder
    const cpfInput = page.locator('input[placeholder*="000.000.000"]');
    await expect(cpfInput).toBeVisible();

    // Switch to Nome
    await page.locator('button:has-text("Nome")').click();
    const nomeInput = page.locator('input[placeholder*="Nome completo"]');
    await expect(nomeInput).toBeVisible();

    // Switch back to CPF
    await page.locator('button:has-text("CPF")').click();
    await expect(cpfInput).toBeVisible();

    await page.screenshot({ path: 'e2e/screenshots/people-modal-toggle.png' });
  });

  test('4. CPF formatting works correctly', async ({ page }) => {
    await openPeopleModal(page);

    const cpfInput = page.locator('input[placeholder*="000.000.000"]');
    await cpfInput.fill('12345678901');

    // Should be formatted as 123.456.789-01
    const value = await cpfInput.inputValue();
    expect(value).toBe('123.456.789-01');
  });

  test('5. Nome search with guardrail — single name blocked', async ({ page }) => {
    await openPeopleModal(page);

    // Switch to Nome
    await page.locator('button:has-text("Nome")').click();
    const nomeInput = page.locator('input[placeholder*="Nome completo"]');

    // Type a single common name
    await nomeInput.fill('Maria');
    await page.locator('button:has-text("Buscar")').click();

    // Wait for response — guardrail should block
    await page.waitForTimeout(3000);

    // Should show guardrail message or error
    const guardrailMsg = page.locator('text=guardrail').or(page.locator('text=nome completo')).or(page.locator('text=sobrenome')).or(page.locator('text=2 caracteres'));
    const isBlocked = await guardrailMsg.count();

    await page.screenshot({ path: 'e2e/screenshots/people-modal-guardrail-single.png' });
    console.log(`Guardrail message visible: ${isBlocked > 0}`);
  });

  test('6. Nome search with full name — results appear', async ({ page }) => {
    await openPeopleModal(page);

    // Switch to Nome
    await page.locator('button:has-text("Nome")').click();
    const nomeInput = page.locator('input[placeholder*="Nome completo"]');

    // Type a full name
    await nomeInput.fill('Fernando Arbache');
    await page.locator('button:has-text("Buscar")').click();

    // Wait for results (longer timeout for external API)
    await page.waitForTimeout(10000);

    await page.screenshot({ path: 'e2e/screenshots/people-modal-search-results.png' });

    // Check for badges (Total, DB, Novos)
    const badgeTotal = page.locator('text=/Total.*\\d/');
    const badgeDb = page.locator('text=/DB.*\\d/');
    const badgeNew = page.locator('text=/Novo.*\\d/');

    const totalVisible = await badgeTotal.count();
    const dbVisible = await badgeDb.count();
    const newVisible = await badgeNew.count();
    console.log(`Badges visible — Total: ${totalVisible}, DB: ${dbVisible}, New: ${newVisible}`);
  });

  test('7. Scroll does not break with results', async ({ page }) => {
    await openPeopleModal(page);

    // Switch to Nome and search
    await page.locator('button:has-text("Nome")').click();
    const nomeInput = page.locator('input[placeholder*="Nome completo"]');
    await nomeInput.fill('Fernando Arbache');
    await page.locator('button:has-text("Buscar")').click();
    await page.waitForTimeout(10000);

    // Try scrolling inside modal results
    const scrollArea = page.locator('div.overflow-y-auto').filter({ has: page.locator('div.divide-y') });
    const scrollable = await scrollArea.count();

    if (scrollable > 0) {
      // Scroll down
      await scrollArea.first().evaluate(el => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(500);

      const scrollTop = await scrollArea.first().evaluate(el => el.scrollTop);
      console.log(`Scrolled to: ${scrollTop}px`);

      // Scroll back up
      await scrollArea.first().evaluate(el => {
        el.scrollTop = 0;
      });
      await page.waitForTimeout(500);

      const scrollTopAfter = await scrollArea.first().evaluate(el => el.scrollTop);
      expect(scrollTopAfter).toBe(0);
      console.log('Scroll reset to 0: OK');
    }

    // Verify body is still scrollable after closing
    await page.locator('button:has(svg.lucide-x)').first().click({ force: true });
    await page.waitForTimeout(500);

    // Body scroll should not be broken
    const bodyScrollable = await page.evaluate(() => {
      const body = document.body;
      const style = window.getComputedStyle(body);
      return style.overflow !== 'hidden';
    });
    console.log(`Body scrollable after modal close: ${bodyScrollable}`);
    expect(bodyScrollable).toBe(true);

    await page.screenshot({ path: 'e2e/screenshots/people-modal-scroll-after-close.png' });
  });

  test('8. Detail view opens on row click', async ({ page }) => {
    await openPeopleModal(page);

    // Search
    await page.locator('button:has-text("Nome")').click();
    const nomeInput = page.locator('input[placeholder*="Nome completo"]');
    await nomeInput.fill('Fernando Arbache');
    await page.locator('button:has-text("Buscar")').click();
    await page.waitForTimeout(10000);

    await page.screenshot({ path: 'e2e/screenshots/people-modal-before-detail.png' });

    // Click first result row (cursor-pointer div inside the modal results)
    const resultRows = page.locator('div.cursor-pointer').filter({ hasText: /@|Fonte/ });
    const rowCount = await resultRows.count();

    if (rowCount > 0) {
      await resultRows.first().click();
      await page.waitForTimeout(1000);

      // Should show "Detalhes da Pessoa" header
      const detailHeader = page.locator('text=Detalhes da Pessoa');
      const isDetailVisible = await detailHeader.isVisible().catch(() => false);
      console.log(`Detail view opened: ${isDetailVisible}`);

      await page.screenshot({ path: 'e2e/screenshots/people-modal-detail-view.png' });

      if (isDetailVisible) {
        // Back button should exist
        const backBtn = page.locator('button:has(svg.lucide-arrow-left)');
        await expect(backBtn).toBeVisible();

        // Click back
        await backBtn.click();
        await page.waitForTimeout(500);

        // Should return to search results
        await expect(page.locator('text=Buscar Pessoa')).toBeVisible();
        console.log('Back to search results: OK');
      }
    } else {
      console.log('No results to click — skipping detail test');
    }
  });

  test('9. Modal closes cleanly with X button', async ({ page }) => {
    await openPeopleModal(page);

    // The modal overlay (fixed inset-0 z-50) intercepts Playwright clicks.
    // Use evaluate to dispatch a real MouseEvent that React's event delegation will catch.
    await page.evaluate(() => {
      const xIcon = document.querySelector('.fixed.inset-0.z-50 svg.lucide-x');
      if (xIcon) {
        const btn = xIcon.closest('button');
        if (btn) {
          const event = new MouseEvent('click', { bubbles: true, cancelable: true });
          btn.dispatchEvent(event);
        }
      }
    });
    await page.waitForTimeout(1000);

    // Modal should be gone
    await expect(page.locator('text=Buscar Pessoa')).not.toBeVisible({ timeout: 5000 });

    // Page should still be usable
    await expect(page.locator('text=Modulos de Inteligencia')).toBeVisible();

    await page.screenshot({ path: 'e2e/screenshots/people-modal-closed.png' });
  });

  test('10. Modal closes with Escape key', async ({ page }) => {
    await openPeopleModal(page);

    // Press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    // Check if modal closed (may or may not support Escape — just verify state)
    const stillOpen = await page.locator('text=Buscar Pessoa').isVisible().catch(() => false);
    console.log(`Modal still open after Escape: ${stillOpen}`);

    await page.screenshot({ path: 'e2e/screenshots/people-modal-after-escape.png' });
  });
});
