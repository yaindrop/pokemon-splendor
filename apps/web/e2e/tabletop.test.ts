import { expect, test } from '@playwright/test';

test.describe('React + Base UI 牌桌', () => {
  test('以 Base UI 表单配置并开始一局本地对战', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /单机对战/ }).click();
    await expect(page.getByText('单机对战设置')).toBeVisible();

    const megaSwitch = page.getByRole('switch', { name: '启用超级进化扩展' });
    await megaSwitch.click();
    await expect(megaSwitch).toHaveAttribute('aria-checked', 'true');

    await page.getByLabel('1 号训练家名字').fill('小智');
    await page.getByRole('button', { name: '开始单机对战' }).click();

    await expect(page.locator('#game')).toBeVisible();
    await expect(page.locator('#supply')).toBeVisible();
    await expect(page.locator('.player[data-player="0"]')).toContainText('小智');
  });

  test('左键领取、右键归还并确认精灵球', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /单机对战/ }).click();
    await page.getByRole('button', { name: '开始单机对战' }).click();

    const red = page.locator('[data-supply-color="red"]');
    await red.click();
    await expect(red).toHaveClass(/picked/);
    await red.click({ button: 'right' });
    await expect(red).not.toHaveClass(/picked/);

    await red.click();
    await page.locator('[data-supply-color="blue"]').click();
    await page.locator('[data-supply-color="black"]').click();
    const confirm = page.getByRole('button', { name: '确认领取精灵球' });
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(
      page.locator('.player[data-player="0"] [data-token-color="red"] .trainer-token-count'),
    ).toHaveText('1');
  });

  test('菜单和记录使用可访问的浮层组件', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /单机对战/ }).click();
    await page.getByRole('button', { name: '开始单机对战' }).click();

    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('menuitem', { name: '规则说明' }).click();
    await expect(page.getByRole('dialog', { name: '游戏规则' })).toBeVisible();
    await page.getByRole('button', { name: '明白了' }).click();

    await page.getByRole('button', { name: '记录' }).click();
    await expect(page.getByRole('dialog', { name: '游戏记录' })).toBeVisible();
    await page.getByRole('button', { name: '关闭游戏记录' }).click();
  });

  test('宽屏重复选择卡牌不会打开阅读浮层', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', '仅验证宽屏的桌面交互');
    await page.goto('/');
    await page.getByRole('button', { name: /单机对战/ }).click();
    await page.getByRole('button', { name: '开始单机对战' }).click();

    const card = page.locator('[data-card]').first();
    await card.click();
    await expect(card).toHaveClass(/selected/);
    await card.click();
    await expect(page.locator('#inspect-inner')).toHaveCount(0);
  });

  test('窄屏再次选择卡牌会打开阅读浮层', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'narrow', '仅验证窄屏的阅读交互');
    await page.goto('/');
    await page.getByRole('button', { name: /单机对战/ }).click();
    await page.getByRole('button', { name: '开始单机对战' }).click();

    const card = page.locator('[data-card]').first();
    await card.click();
    await card.click();
    await expect(page.locator('#inspect-inner')).toBeVisible();
  });

  test('两位训练家通过真实房间同步回合', async ({ browser, page }, testInfo) => {
    const baseUrl = testInfo.project.use.baseURL;
    if (!baseUrl) throw new Error('Playwright 必须配置 baseURL');
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await page.goto('/');
      await page.getByRole('button', { name: /和朋友联机/ }).click();
      await page.getByLabel('训练家名字').fill('小智');
      await page.getByRole('button', { name: '创建联机房间' }).click();
      await expect(page.getByText('房间码')).toBeVisible();
      const roomCode = await page.locator('.lobby-code b').textContent();
      if (!roomCode) throw new Error('房主未获得房间码');

      await guest.goto(baseUrl);
      await guest.getByRole('button', { name: /和朋友联机/ }).click();
      await guest.getByLabel('训练家名字').fill('小霞');
      await guest.getByPlaceholder('输入房间码').fill(roomCode);
      await guest.getByRole('button', { name: '加入', exact: true }).click();

      await expect(page.getByText(/2\. 小霞/)).toBeVisible();
      await expect(guest.getByText(/1\. 小智/)).toBeVisible();
      await page.getByRole('button', { name: '开始游戏' }).click();

      await expect(page.locator('#game')).toBeVisible();
      await expect(guest.locator('#game')).toBeVisible();

      await page.locator('[data-supply-color="red"]').click();
      await page.locator('[data-supply-color="blue"]').click();
      await page.locator('[data-supply-color="black"]').click();
      await page.getByRole('button', { name: '确认领取精灵球' }).click();

      await expect(
        guest.locator('.player[data-player="0"] [data-token-color="red"] .trainer-token-count'),
      ).toHaveText('1');

      await guest.locator('[data-supply-color="red"]').click();
      await guest.locator('[data-supply-color="blue"]').click();
      await guest.locator('[data-supply-color="black"]').click();
      await guest.getByRole('button', { name: '确认领取精灵球' }).click();

      await expect(
        page.locator('.player[data-player="1"] [data-token-color="red"] .trainer-token-count'),
      ).toHaveText('1');
    } finally {
      await guestContext.close();
    }
  });
});
