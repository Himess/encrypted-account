/** Landing page: navigation state, scroll reveals, the "decrypting" headline and the phone demo loop. No wallet, no SDK. */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const HEX = "0123456789abcdef";
const rand = (s: string) => s[Math.floor(Math.random() * s.length)];

// ── nav border once the page scrolls
const nav = document.getElementById("nav");
const onScroll = () => nav?.classList.toggle("scrolled", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// ── reveal on scroll, staggered inside each parent
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      const sibs = Array.from(el.parentElement?.querySelectorAll(":scope > .reveal") ?? []);
      el.style.transitionDelay = `${Math.max(0, sibs.indexOf(el)) * 70}ms`;
      el.classList.add("in");
      io.unobserve(el);
    }
  },
  { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
);
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

// ── headline: scrambled characters resolve left to right
function scramble(el: HTMLElement, duration = 900) {
  const target = el.textContent ?? "";
  if (reduced || !target) return;
  const t0 = performance.now();
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / duration);
    const done = Math.floor(p * target.length);
    let out = "";
    for (let i = 0; i < target.length; i++) out += i < done || target[i] === " " ? target[i] : rand(HEX);
    el.textContent = out;
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = target;
  };
  requestAnimationFrame(tick);
}
document.querySelectorAll<HTMLElement>("[data-scramble]").forEach((el) => setTimeout(() => scramble(el), 250));

// ── encrypted address book: ciphertext that keeps changing
const cipherRows = Array.from(document.querySelectorAll<HTMLElement>("[data-cipher]"));
if (!reduced && cipherRows.length) {
  setInterval(() => {
    const el = cipherRows[Math.floor(Math.random() * cipherRows.length)];
    let n = 0;
    const id = setInterval(() => {
      el.textContent = `0x${Array.from({ length: 6 }, () => rand(HEX)).join("")}…${rand(HEX)}${rand(HEX)}`;
      if (++n > 7) clearInterval(id);
    }, 45);
  }, 1400);
}

// ── phone demo: someone with the key tries a PIN, the check fails, nothing moves
const device = document.getElementById("device");
const dotsWrap = document.getElementById("d-dots");
const state = document.getElementById("d-state");
const safe = document.getElementById("d-safe");
if (device && dotsWrap && state && safe) {
  const dots = Array.from(dotsWrap.querySelectorAll("i"));
  const keys = Array.from(document.querySelectorAll<HTMLElement>("#d-keys span")).filter((k) => !k.classList.contains("blank") && !k.classList.contains("del"));
  const setState = (text: string, cls = "") => {
    state.textContent = text;
    state.className = `d-state ${cls}`;
  };
  const setSafe = (text: string) => {
    safe.innerHTML = `<span class="dot live"></span>${text}`;
  };

  let visible = true;
  new IntersectionObserver((es) => (visible = es[0].isIntersecting), { threshold: 0.2 }).observe(device);
  const wait = async (ms: number) => {
    await sleep(ms);
    while (!visible || document.hidden) await sleep(300);
  };

  if (reduced) {
    dots.forEach((d) => (d.className = "bad"));
    setState("Wrong PIN · nothing moved", "bad");
    setSafe("Nothing moved · funds safe");
  } else {
    void (async () => {
      let attempt = 0;
      for (;;) {
        attempt = (attempt % 3) + 1;
        dots.forEach((d) => (d.className = ""));
        dotsWrap.classList.remove("shake");
        setState("Checked under FHE");
        setSafe("Protected by PIN");
        await wait(1100);
        for (let i = 0; i < dots.length; i++) {
          const k = keys[Math.floor(Math.random() * keys.length)];
          k.classList.add("press");
          dots[i].classList.add("on");
          await wait(130);
          k.classList.remove("press");
          await wait(110 + Math.random() * 110);
        }
        await wait(250);
        setState("Encrypting the guess…", "busy");
        await wait(900);
        setState("Counting the attempt on-chain…", "busy");
        await wait(1100);
        setState("Decrypting only yes / no…", "busy");
        await wait(1000);
        dots.forEach((d) => (d.className = "bad"));
        void dotsWrap.offsetWidth;
        dotsWrap.classList.add("shake");
        setState("Wrong PIN · nothing moved", "bad");
        setSafe("Nothing moved · funds safe");
        await wait(1700);
        if (attempt < 3) setState(`Attempt ${attempt} counted on-chain`);
        else setState("3rd wrong guess · next try in 15 min", "bad");
        await wait(attempt < 3 ? 1500 : 2600);
      }
    })();
  }
}
