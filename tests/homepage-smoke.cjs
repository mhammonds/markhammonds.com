const { test } = require('node:test');
/* Serve the repo, then run with Puppeteer. Optional PUPPETEER_MODULE / CHROME_BIN / SITE_URL. */
const assert = require('node:assert/strict');
const { launchBrowser, closeBrowser, artifactPath, settlePage } = require('./helpers/browser.cjs');
const identity = require('./helpers/identity.cjs');
const site = process.env.SITE_URL || 'http://localhost:8000/';
// Matches the camera roll's photo list in script.js.
const PHOTO_COUNT = 7;

async function assertMobileGestures(page) {
  const client = await page.createCDPSession();
  const center = (selector) =>
    page.$eval(selector, async (element) => {
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      let previous;
      let stableFrames = 0;
      const deadline = performance.now() + 5000;
      while (stableFrames < 3) {
        if (performance.now() > deadline) {
          throw new Error(`Gesture target did not settle: ${JSON.stringify(previous)}`);
        }
        await new Promise(requestAnimationFrame);
        const bounds = element.getBoundingClientRect();
        const position = [bounds.left, bounds.top, scrollY, visualViewport.pageTop];
        stableFrames = position.every((value, index) => value === previous?.[index])
          ? stableFrames + 1
          : 0;
        previous = position;
      }
      const bounds = element.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    });
  const clearSelection = () => page.evaluate(() => getSelection().removeAllRanges());
  async function pinchAt({ x, y }) {
    // Linux's high-level synthesizePinchGesture delivers touch events without
    // zooming even an unrestricted page. Explicit fingers exercise the native
    // recognizer on every platform, including its CSS touch-action restrictions.
    const touches = (distance) => [
      { id: 0, x, y: y - distance },
      { id: 1, x, y: y + distance },
    ];
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: touches(40),
    });
    try {
      for (let step = 1; step <= 12; step++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: touches(40 + step * 8),
        });
        const scale = await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          return visualViewport.scale;
        });
        if (scale >= 1.75) break;
      }
    } finally {
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  }
  async function assertPinchZoom(selector, label) {
    await clearSelection();
    const point = await center(selector);
    await pinchAt(point);
    try {
      await page.waitForFunction(() => visualViewport.scale >= 1.5, { timeout: 3000 });
    } catch (error) {
      const viewport = await page.evaluate(() => ({
        scale: visualViewport.scale,
        scrollY,
        viewportTop: visualViewport.pageTop,
      }));
      throw new Error(
        `${label}: a native pinch did not enlarge content: ${JSON.stringify({ point, viewport })}`,
        { cause: error },
      );
    }
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await page.waitForFunction(() => Math.abs(visualViewport.scale - 1) < 0.01);
  }
  async function assertTextSelection(selector, label) {
    await clearSelection();
    await center(selector);
    const text = await page.$eval(selector, (element) => {
      const nodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = nodes.nextNode())) {
        if (node.parentElement.closest('button') || !/[A-Za-z]{3}/.test(node.textContent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = getSelection();
        selection.addRange(range);
        const normalize = (value) => value.trim().replace(/\s+/g, ' ');
        return { expected: normalize(node.textContent), selected: normalize(selection.toString()) };
      }
    });
    assert.ok(text?.expected, `${label}: the copy fixture contains visible text`);
    assert.equal(text.selected, text.expected, `${label}: text can be selected for copying`);
    await clearSelection();
  }

  try {
    const point = await page.$eval('.scene', (scene) => {
      scene.scrollIntoView({ block: 'start', behavior: 'instant' });
      const bounds = scene.getBoundingClientRect();
      const x = bounds.left + 10;
      const y = bounds.top + bounds.height / 4;
      return { x, y, control: Boolean(document.elementFromPoint(x, y)?.closest('a, button')) };
    });
    assert.equal(point.control, false, 'The missed-tap fixture falls outside interactive objects');
    await client.send('Input.synthesizeTapGesture', {
      x: point.x,
      y: point.y,
      tapCount: 2,
      gestureSourceType: 'touch',
    });
    assert.ok(
      Math.abs((await page.evaluate(() => visualViewport.scale)) - 1) < 0.01,
      'Repeated taps outside hotspots do not zoom the illustration',
    );
    await pinchAt({ x: 190, y: 150 });
    assert.ok(
      Math.abs((await page.evaluate(() => visualViewport.scale)) - 1) < 0.01,
      'A two-finger pinch inside the illustration does not zoom it',
    );
    await client.send('Input.synthesizeTapGesture', {
      x: point.x,
      y: point.y,
      duration: 900,
      gestureSourceType: 'touch',
    });
    assert.equal(
      await page.evaluate(() => getSelection().toString()),
      '',
      'Long presses do not select the illustration',
    );
    // Drive a real touch sequence. Chromium's synthesized scroll command can
    // complete without scrolling on headless Linux, even with touch enabled.
    // The homepage can fit a tall phone without scrolling, so give it room to scroll:
    // the check is that a drag starting on the illustration scrolls the page.
    await page.evaluate(() => {
      document.body.style.minHeight = `${innerHeight * 2}px`;
    });
    const minimumScroll = 100;
    const drag = await page.touchscreen.touchStart(point.x, point.y + 140);
    try {
      for (let step = 1; step <= 6; step++) {
        await drag.move(point.x, point.y + 140 - step * 30);
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await page.waitForFunction((minimum) => scrollY > minimum, {}, minimumScroll);
    } finally {
      await drag.end();
    }
    assert.ok(
      await page.evaluate((minimum) => scrollY > minimum, minimumScroll),
      'A vertical touch drag still scrolls the homepage',
    );
    await page.evaluate(() => {
      document.body.style.minHeight = '';
    });
    await assertPinchZoom('.intro p', 'Homepage introduction');
    await assertTextSelection('.intro p', 'Homepage introduction');

    await page.click('.bible-toggle .hotspot-pin');
    await assertTextSelection('#verse-text', 'John 3:16');
    await assertPinchZoom('#verse-text', 'Verse card');
    await page.click('#verse-dialog [data-dialog-close]');

    await page.click('#name button');
    await assertTextSelection(
      '.business-card-email span:not([aria-hidden])',
      'Business card email',
    );
    await assertPinchZoom('.business-card-email', 'Business card');
    await page.click('.business-card-close');

    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await settlePage(page);
  } finally {
    await client.detach();
  }
}

test('homepage smoke', { timeout: 300_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await page.setViewport({ width: 1440, height: 1100 });
    await page.evaluateOnNewDocument(() => {
      const NativeDate = Date;
      let now = NativeDate.parse('2026-01-15T18:00:00Z');
      window.Date = class extends NativeDate {
        constructor(...args) {
          super(...(args.length ? args : [now]));
        }
        static now() {
          return now;
        }
      };
      window.setTestClock = (value) => {
        now = NativeDate.parse(value);
        window.dispatchEvent(new Event('focus'));
      };
      if (!sessionStorage.getItem('homepage-test-seeded')) {
        localStorage.clear();
        localStorage.setItem('mark-site-theme', 'night');
        sessionStorage.setItem('homepage-test-seeded', '1');
      }
    });
    await page.goto(site, { waitUntil: 'networkidle0' });
    const isNight = () => page.evaluate(() => document.documentElement.classList.contains('night'));
    assert.equal(
      await isNight(),
      false,
      'Old permanently saved theme does not override the new schedule',
    );
    const fixtures = [
      ['2026-01-15T10:59:00Z', true],
      ['2026-01-15T11:00:00Z', false],
      ['2026-01-15T23:59:00Z', false],
      ['2026-01-16T00:00:00Z', true],
      ['2026-01-16T05:00:00Z', true],
      ['2026-01-16T11:00:00Z', false],
      ['2026-07-15T09:59:00Z', true],
      ['2026-07-15T10:00:00Z', false],
      ['2026-07-15T22:59:00Z', false],
      ['2026-07-15T23:00:00Z', true],
    ];
    for (const [time, night] of fixtures) {
      await page.evaluate((time) => setTestClock(time), time);
      assert.equal(await isNight(), night, `Eastern schedule at ${time}`);
    }
    await page.evaluate(() => setTestClock('2026-01-15T18:00:00Z'));
    await page.click('.theme-toggle');
    assert.equal(await isNight(), true, 'Manual theme switch works');
    await page.reload({ waitUntil: 'networkidle0' });
    assert.equal(
      await isNight(),
      true,
      'Manual choice survives reload within the same time period',
    );
    await page.evaluate(() => setTestClock('2026-01-16T00:00:00Z'));
    assert.equal(
      await page.evaluate(() => localStorage.getItem('site-theme-override')),
      null,
      'Next scheduled boundary expires manual override',
    );
    await page.evaluate(() => setTestClock('2026-01-16T11:00:00Z'));
    assert.equal(await isNight(), false, 'Following morning automatically returns to day');
    const navigationLinks = await page.$$eval('a[href]', (els) =>
      els
        .filter(
          (el) =>
            el.getAttribute('href') &&
            !el.getAttribute('href').startsWith('#') &&
            ['http:', 'https:'].includes(new URL(el.href).protocol),
        )
        .map((el) => ({ href: el.getAttribute('href'), target: el.target, rel: [...el.relList] })),
    );
    assert.ok(navigationLinks.length > 0, 'Homepage has navigation links to check');
    for (const link of navigationLinks) {
      assert.equal(link.target, '_blank', `${link.href} opens in a new tab`);
      assert.ok(
        link.rel.includes('noopener') && link.rel.includes('noreferrer'),
        `${link.href} protects the originating page`,
      );
    }

    const { socialLinks, screenLinks } = identity;
    for (const [href, label] of screenLinks) {
      const selector = `.scene a[href="${href}"]`;
      assert.equal(
        await page.$$eval(selector, (els) => els.length),
        1,
        `${label} screen link is present once`,
      );
      await page.hover(selector);
      assert.ok(
        await page.$eval(
          `${selector} .label`,
          (el, label) => el.textContent.includes(label),
          label,
        ),
        `${label} has the requested hover label`,
      );
    }
    assert.deepEqual(
      await page.$$eval('.quick-links a', (els) =>
        els.map((el) => [el.getAttribute('href'), el.textContent.trim()]),
      ),
      socialLinks,
      'Submenu contains only the two requested social links',
    );
    // Games return in v2; until then the homepage neither lists nor links them.
    assert.equal(
      await page.$$eval(
        '.project-card, a[href$="riders.html"], a[href$="racer.html"], a[href$="trail.html"]',
        (els) => els.length,
      ),
      0,
      'Games stay hidden until v2',
    );
    assert.deepEqual(
      await page.$$eval('.intro p a', (links) =>
        links.map((link) => [link.textContent.trim(), link.getAttribute('href')]),
      ),
      [['American Cloud', identity.companyUrl]],
      'The introduction links to American Cloud',
    );
    assert.deepEqual(
      await page.$eval('footer .hosted-by', (link) => ({
        text: link.textContent.replace(/\s+/g, ' ').trim(),
        href: link.getAttribute('href'),
        icon: Boolean(link.querySelector('svg[aria-hidden="true"]')),
      })),
      {
        text: 'Hosted on American Cloud',
        href: `${identity.companyUrl}?utm_source=aronwagner.com`,
        icon: true,
      },
      'The footer credits American Cloud hosting',
    );
    assert.equal(
      await page.evaluate(() => /Asteroids|CR Surf Rides/i.test(document.body.innerText)),
      false,
      'Retired game and old title are absent',
    );
    assert.deepEqual(
      await page.$$eval('a[href^="mailto:"]', (els) => els.map((el) => el.getAttribute('href'))),
      [`mailto:${identity.email}`, `mailto:${identity.email}?subject=Golf`],
      'The business card and golf invitation provide the requested email address',
    );
    assert.equal(
      await page.evaluate(() => /Amor Fati/i.test(document.body.textContent)),
      false,
      'Retired motto is absent, including closed dialog content',
    );
    const popupOpen = () => page.$eval('#business-card-dialog', (el) => el.open);
    await page.click('#name button');
    assert.equal(await popupOpen(), true, 'Signature opens the business card');
    assert.equal(
      await page.$eval('#business-card-name', (el) => el.textContent.trim()),
      identity.name,
    );
    assert.equal(
      await page.$eval('.business-card-title', (el) => el.textContent.trim()),
      identity.title,
    );
    assert.ok(
      await page.$eval('.business-card-logo', (el) => {
        const img = el.querySelector('img');
        return (
          el.textContent.trim() === 'American Cloud' &&
          new URL(img.src).origin === location.origin &&
          new URL(img.src).pathname.endsWith('/assets/brand/american-cloud-icon.svg') &&
          img.complete &&
          img.naturalWidth > 0
        );
      }),
      'Local American Cloud icon loads beside the wordmark',
    );
    for (const selector of ['.business-card-logo', '.business-card-website']) {
      assert.equal(
        await page.$eval(selector, (el) => el.href),
        identity.companyUrl,
        'Card logo and website link to American Cloud',
      );
    }
    assert.deepEqual(
      await page.$eval('#business-card-dialog .business-card-email', (link) => ({
        text: link.querySelector('span:not([aria-hidden])').textContent.trim(),
        href: link.getAttribute('href'),
        target: link.target,
        rel: [...link.relList].sort(),
        label: link.getAttribute('aria-label'),
      })),
      {
        text: identity.email,
        href: `mailto:${identity.email}`,
        target: '',
        rel: [],
        label: `Email ${identity.firstName} at ${identity.email} (opens your email app)`,
      },
      'The email link opens the mail app without requesting an empty browser tab',
    );
    await page.screenshot({ path: artifactPath('homepage-business-card-desktop.png') });
    await page.keyboard.press('Escape');
    assert.equal(await popupOpen(), false, 'Escape closes the popup');
    assert.ok(
      await page.evaluate(() => !!document.activeElement.closest('#name')),
      'Focus returns to the triggering name',
    );
    await page.keyboard.press('Enter');
    assert.equal(await popupOpen(), true, 'Name supports keyboard activation');
    await page.click('.business-card-close');
    assert.equal(await popupOpen(), false, 'Close button dismisses the popup');
    await page.click('.portrait');
    assert.equal(await popupOpen(), true, 'Portrait opens the same popup');
    await page.mouse.click(10, 10);
    assert.equal(await popupOpen(), false, 'Backdrop click dismisses the popup');
    for (const selector of ['.intro p [data-business-card]', 'footer [data-business-card]']) {
      await page.click(selector);
      assert.equal(await popupOpen(), true, 'Other visible name instances open the popup');
      await page.click('.business-card-close');
    }

    const polaroidOpen = () => page.$eval('#polaroid-dialog', (el) => el.open);
    const loadedPhoto = async (previous) => {
      await page.waitForFunction(
        (previous) => {
          const photo = document.querySelector('.polaroid-photo');
          return (
            photo &&
            photo.complete &&
            photo.naturalWidth > 0 &&
            photo.currentSrc &&
            photo.currentSrc !== previous
          );
        },
        {},
        previous || '',
      );
      const photo = await page.$eval('.polaroid-photo', (el) => ({
        src: el.currentSrc,
        alt: el.alt,
      }));
      const source = new URL(photo.src);
      assert.equal(source.origin, new URL(site).origin, 'Camera photo loads from the local site');
      assert.match(source.pathname, /\.jpg$/i, 'Camera displays a converted JPG');
      assert.ok(photo.alt.trim(), 'Camera photo has alternative text');
      return photo.src;
    };
    assert.equal(
      await page.$eval('.polaroid-photo', (el) => !!el.getAttribute('src')),
      false,
      'Photo loading waits until the camera is opened',
    );
    await page.click('.camera-toggle');
    assert.equal(await polaroidOpen(), true, 'Camera opens the photo viewer');
    let previousPhoto = await loadedPhoto();
    const photoBag = new Set([previousPhoto]);
    for (let i = 1; i < PHOTO_COUNT; i++) {
      if (i === 1) {
        await page.focus('.polaroid-next');
        await page.keyboard.press('Enter');
      } else await page.click('.polaroid-next');
      previousPhoto = await loadedPhoto(previousPhoto);
      photoBag.add(previousPhoto);
      if (i === 1)
        assert.equal(
          await page.evaluate(() => document.activeElement.matches('.polaroid-next')),
          true,
          'Another photo retains keyboard focus after loading',
        );
    }
    assert.equal(
      photoBag.size,
      PHOTO_COUNT,
      'Every photo appears once before the shuffled collection repeats',
    );
    await page.click('.polaroid-next');
    previousPhoto = await loadedPhoto(previousPhoto);
    assert.ok(
      photoBag.has(previousPhoto),
      'A new shuffled collection reuses the same local photos',
    );
    await page.screenshot({ path: artifactPath('homepage-polaroid-desktop.png') });
    await page.keyboard.press('Escape');
    assert.equal(await polaroidOpen(), false, 'Escape closes the photo viewer');
    assert.equal(
      await page.evaluate(() => document.activeElement.matches('.camera-toggle')),
      true,
      'Closing returns keyboard focus to the camera',
    );
    await page.keyboard.press('Enter');
    assert.equal(await polaroidOpen(), true, 'Camera supports keyboard activation');
    previousPhoto = await loadedPhoto(previousPhoto);
    await page.click('.polaroid-close');
    assert.equal(await polaroidOpen(), false, 'Photo viewer close button works');
    await page.click('.camera-toggle');
    await loadedPhoto(previousPhoto);
    await page.mouse.click(10, 10);
    assert.equal(await polaroidOpen(), false, 'Clicking the backdrop closes the photo viewer');

    const weddingOpen = () => page.$eval('#wedding-dialog', (dialog) => dialog.open);
    assert.equal(
      await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .some((entry) => entry.name.includes('wedding-day')),
      ),
      false,
      'The wedding photo waits until Rebecca is clicked',
    );
    await page.click('.rebecca');
    assert.equal(await weddingOpen(), true, 'Clicking Rebecca opens the wedding photo');
    assert.deepEqual(
      await page.$eval('#wedding-dialog .polaroid-photo', async (photo) => {
        await photo.decode();
        return { loaded: photo.naturalWidth > 0, alt: photo.alt };
      }),
      {
        loaded: true,
        alt: 'Aron and Rebecca on their wedding day in front of a historic stone church.',
      },
      'The wedding photo loads with a description',
    );
    await page.keyboard.press('Escape');
    assert.equal(await weddingOpen(), false, 'Escape closes the wedding photo');
    assert.equal(
      await page.evaluate(() => document.activeElement.matches('.rebecca')),
      true,
      'Closing the wedding photo returns focus to Rebecca',
    );
    const dogStatus = () => page.$eval('#dog-status', (status) => status.textContent);
    await page.click('.toys-toggle');
    assert.match(await dogStatus(), /Maggie|fetch/, 'Playing fetch announces what Maggie did');
    await page.waitForFunction(() =>
      document.querySelector('.dog').classList.contains('is-squeaking'),
    );
    assert.ok(
      await page.$eval('.scene', (scene) => scene.classList.contains('toy-thrown')),
      'Playing fetch tosses a squeak toy',
    );
    const fetched = await dogStatus();
    await page.click('.toys-toggle');
    assert.notEqual(await dogStatus(), fetched, 'Another round of fetch has a new message');
    await page.click('.dog');
    assert.match(await dogStatus(), /Maggie/, 'Petting Maggie announces her reaction');
    await page.evaluate(() => setTestClock('2026-01-16T02:00:00Z'));
    await settlePage(page);
    await page.screenshot({ path: artifactPath('homepage-night.png'), fullPage: true });

    const tapRegion = async (selector) => {
      const point = await page.$eval(selector, (region) => {
        region.scrollIntoView({ block: 'center', behavior: 'instant' });
        const bounds = region.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      });
      await page.touchscreen.tap(point.x, point.y);
    };
    const tapPin = (selector) => tapRegion(`${selector} .hotspot-pin`);
    for (const width of [390, 768]) {
      await page.setViewport({
        width,
        height: 1000,
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      await page.goto(site, { waitUntil: 'networkidle0' });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'No horizontal overflow',
      );
      if (width === 390) {
        const pins = await page.$$eval('.hotspot-pin', (pins) =>
          pins.map((pin) => ({
            control: pin.parentElement.className,
            pulsing: [null, '::before', '::after'].some((pseudo) => {
              const style = getComputedStyle(pin, pseudo);
              return (
                style.animationName !== 'none' &&
                parseFloat(style.animationDuration) > 0 &&
                style.animationIterationCount === 'infinite'
              );
            }),
          })),
        );
        assert.equal(pins.length, 8, 'Eight scene objects have touch pins');
        assert.equal(
          await page.$$eval('.portrait .hotspot-pin, .dog .hotspot-pin', (pins) => pins.length),
          0,
          'Aron and Maggie remain free of pin dots',
        );
        for (const pin of pins) {
          assert.equal(pin.pulsing, true, `${pin.control} pin pulses with normal motion`);
        }
        assert.ok(
          await page.$$eval('.scene img', (images) => images.every((image) => !image.draggable)),
          'Illustration images do not start native drag gestures',
        );
        await assertMobileGestures(page);
      }
      for (const [href, label] of screenLinks) {
        assert.ok(
          await page.$eval(`.scene a[href="${href}"]`, (el) => {
            const r = el.getBoundingClientRect(),
              hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return hit === el || el.contains(hit);
          }),
          `${label} screen can be tapped at ${width}px`,
        );
      }
      await page.click('#name button');
      assert.equal(await popupOpen(), true, 'Mobile name tap opens popup');
      assert.ok(
        await page.$eval('#business-card-dialog', (el) => {
          const r = el.getBoundingClientRect();
          return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight;
        }),
        'Business card fits mobile viewport',
      );
      await page.screenshot({ path: artifactPath(`homepage-business-card-${width}.png`) });
      await page.click('.business-card-close');
      assert.equal(await popupOpen(), false);
      if (width === 390) {
        await tapRegion('.portrait');
        assert.equal(await popupOpen(), true, 'Tapping Aron opens the business card without a pin');
        await page.click('.business-card-close');
        const petted = await dogStatus();
        await tapRegion('.dog');
        assert.notEqual(await dogStatus(), petted, 'Tapping Maggie pets her without a pin');
        const beforeFetch = await dogStatus();
        await tapPin('.toys-toggle');
        assert.notEqual(await dogStatus(), beforeFetch, 'The toy bin pin plays fetch');
      }
      // Full-page capture resets Chromium's touch emulation. Capture only after
      // interaction checks; the next iteration configures its own input device.
      await page.screenshot({ path: artifactPath(`homepage-${width}.png`), fullPage: true });
    }
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewport({ ...viewport, isMobile: true, hasTouch: true });
      await page.goto(site, { waitUntil: 'networkidle0' });
      await tapPin('.camera-toggle');
      assert.equal(await polaroidOpen(), true, 'Tapping the camera pin opens the photo viewer');
      let prior = '';
      for (let i = 0; i < PHOTO_COUNT; i++) {
        if (i) await page.click('.polaroid-next');
        prior = await loadedPhoto(prior);
        const fit = await page.evaluate(() => {
          const dialog = document.querySelector('#polaroid-dialog');
          const items = [
            dialog,
            ...dialog.querySelectorAll(
              '.polaroid-frame,.polaroid-photo,.polaroid-next,.polaroid-close',
            ),
          ];
          const overflow = getComputedStyle(dialog);
          return {
            visible: items.every((el) => {
              const r = el.getBoundingClientRect();
              return (
                r.width > 0 &&
                r.height > 0 &&
                r.left >= -1 &&
                r.top >= -1 &&
                r.right <= innerWidth + 1 &&
                r.bottom <= innerHeight + 1
              );
            }),
            scrolls:
              (['auto', 'scroll'].includes(overflow.overflowY) &&
                dialog.scrollHeight > dialog.clientHeight + 1) ||
              (['auto', 'scroll'].includes(overflow.overflowX) &&
                dialog.scrollWidth > dialog.clientWidth + 1),
          };
        });
        assert.ok(
          fit.visible,
          `Photo ${i + 1}, its frame and both controls fit ${viewport.width}×${viewport.height}`,
        );
        assert.equal(fit.scrolls, false, 'Photo viewer needs no internal scrolling');
      }
      await page.screenshot({ path: artifactPath(`homepage-polaroid-${viewport.width}.png`) });
      await page.click('.polaroid-close');
      assert.equal(await polaroidOpen(), false, 'Mobile close control dismisses the photo viewer');
    }
    assert.deepEqual(errors, [], 'No JavaScript errors or failed homepage assets');
    console.log(
      'PASS: Eastern schedule (winter/summer), manual override expiry, new-tab navigation, hidden games, social screen and submenu links, American Cloud business card and email link, seven-photo Polaroid shuffle, Rebecca’s wedding photo and keyboard controls, Maggie’s fetch and pets, pulsing touch pins and touchscreen activation, scene-scoped gesture protection, selectable and zoomable page/dialog text, all three game cards, and responsive layouts.',
    );
  } finally {
    await closeBrowser(browser);
  }
});
