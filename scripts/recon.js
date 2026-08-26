const { chromium } = require('/app/node_modules/playwright');

(async () => {
  const b = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await b.newContext({ viewport: { width: 1366, height: 850 } });
  const p = await ctx.newPage();
  const out = { steps: [] };
  const shot = async (n) => {
    try { await p.screenshot({ path: '/app/data/shots/' + n }); } catch {}
  };
  const dump = () =>
    p.evaluate(() => ({
      url: location.href,
      title: document.title,
      inputs: [...document.querySelectorAll('input,textarea')].map((i) => ({
        t: i.type, name: i.name, id: i.id, ph: i.placeholder, vis: !!i.offsetParent,
      })),
      buttons: [...document.querySelectorAll('button,[role=button],input[type=submit]')]
        .map((b2) => ({
          txt: (b2.innerText || b2.value || '').trim().slice(0, 40),
          cls: String(b2.className).slice(0, 50),
          vis: !!b2.offsetParent,
        }))
        .slice(0, 25),
      links: [...document.querySelectorAll('a')]
        .map((a) => ({ txt: a.innerText.trim().slice(0, 30), href: a.getAttribute('href') }))
        .filter((l) => l.txt)
        .slice(0, 25),
      bodyText: document.body.innerText.slice(0, 700),
    }));

  try {
    await p.goto('https://hub.alemi.kz', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(5000);
    await shot('recon-1-landing.png');
    let d = await dump();
    out.steps.push({ step: 'landing', ...d });

    const emailLoc = p.locator('#hub-identifier').first();
    const passLoc = p.locator('#hub-password').first();

    if ((await passLoc.count()) > 0 && process.env.RECON_PASS) {
      const robust = async (loc, val) => {
        await loc.click({ timeout: 5000 }).catch(() => {});
        await loc.fill(val, { timeout: 5000 }).catch(() => {});
        const v = await loc.inputValue().catch(() => '');
        if (v !== val) {
          await loc.fill('').catch(() => {});
          await loc.pressSequentially(val, { delay: 50 }).catch(() => {});
        }
      };
      await robust(emailLoc, 'qazaqtimr@gmail.com');
      await robust(passLoc, process.env.RECON_PASS);
      await shot('recon-2-filled.png');
      const submit = p
        .locator('.partner-auth-submit, button[type=submit]')
        .first();
      await submit.click().catch(async () => { await passLoc.press('Enter'); });
      await p.waitForTimeout(7000);
      await shot('recon-3-afterlogin.png');
      d = await dump();
      out.steps.push({ step: 'afterLogin', ...d });
    } else {
      out.steps.push({ step: 'noLoginFormVisible' });
    }
  } catch (e) {
    out.error = String(e).slice(0, 300);
    await shot('recon-err.png');
  }

  require('fs').writeFileSync('/tmp/recon.json', JSON.stringify(out, null, 2));
  console.log('===RECON===');
  console.log(JSON.stringify(out).slice(0, 2600));
  await b.close();
})();
