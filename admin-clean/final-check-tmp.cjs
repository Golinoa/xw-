const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath:
      'C:/Users/Agust/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  await page.goto('http://127.0.0.1:5300/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);

  console.log('落地 URL:', page.url());
  console.log('标题:', await page.title());
  console.log('邮箱框:', await page.locator('input[placeholder*="邮箱"]').count());
  console.log('密码框:', await page.locator('input[type="password"]').count());
  const body = await page.locator('body').innerText();
  console.log('含 Vben 模板文案:', /开箱即用|中后台管理系统|Vben Admin/.test(body));
  console.log('版权行:', body.split('\n').filter((l) => l.includes('Copyright')).join(' | '));
  console.log('控制台错误:', errors.length ? errors.slice(0, 3).join(' ; ') : '(无)');

  await page.screenshot({
    path: 'D:/Coding/ERP/admin-clean/vben-login-20261121.png',
  });

  await page.goto('http://127.0.0.1:5300/#/finance/settlements', {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(1200);
  console.log('守护跳转:', page.url());

  await browser.close();
})();
