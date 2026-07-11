/**
 * Spaghetti docs — minimal client interactions
 * Theme toggle, mobile nav, copy-to-clipboard, API method toggles, sidebar active state
 */
(function () {
  "use strict";

  // ── Theme (dark default, light optional, persisted) ─────────────────────
  var THEME_KEY = "spaghetti-docs-theme";

  function applyTheme(theme) {
    var t = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch (_) {
      /* ignore */
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "light" ? "#f4f6f8" : "#050607");
    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      btn.setAttribute("aria-label", t === "light" ? "Switch to dark theme" : "Switch to light theme");
      btn.setAttribute("title", t === "light" ? "Dark mode" : "Light mode");
    });
  }

  function initTheme() {
    var stored = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch (_) {
      /* ignore */
    }
    if (stored === "light" || stored === "dark") {
      applyTheme(stored);
    } else {
      // Product default is dark (terminal craft).
      applyTheme("dark");
    }
  }

  initTheme();

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    var current = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(current === "light" ? "dark" : "light");
  });

  // ── Mobile nav ──────────────────────────────────────────────────────────
  const toggle = document.getElementById("nav-toggle");
  const links = document.getElementById("nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      const open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "✕" : "☰";
    });
    links.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        links.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "☰";
      });
    });
  }

  // ── Copy buttons ────────────────────────────────────────────────────────
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const block = btn.closest(".code-block");
      if (!block) return;
      const pre = block.querySelector("pre");
      if (!pre) return;
      const text = pre.innerText.replace(/\n$/, "");
      const done = function () {
        const prev = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(function () {
          btn.textContent = prev;
          btn.classList.remove("copied");
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {
          fallbackCopy(text, done);
        });
      } else {
        fallbackCopy(text, done);
      }
    });
  });

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (_) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  // ── API method accordion ────────────────────────────────────────────────
  document.querySelectorAll(".method-header[data-toggle]").forEach(function (header) {
    header.addEventListener("click", function () {
      const method = header.closest(".method");
      if (!method) return;
      method.classList.toggle("open");
    });
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        header.click();
      }
    });
  });

  // ── Sidebar scroll-spy ──────────────────────────────────────────────────
  const sidebar = document.querySelector(".api-sidebar");
  if (sidebar) {
    const sectionIds = Array.from(sidebar.querySelectorAll('a[href^="#"]'))
      .map(function (a) {
        return a.getAttribute("href").slice(1);
      })
      .filter(Boolean);

    const sections = sectionIds
      .map(function (id) {
        return document.getElementById(id);
      })
      .filter(Boolean);

    function setActive(id) {
      sidebar.querySelectorAll("a").forEach(function (a) {
        a.classList.toggle("active", a.getAttribute("href") === "#" + id);
      });
    }

    if ("IntersectionObserver" in window && sections.length) {
      const io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              setActive(entry.target.id);
            }
          });
        },
        { rootMargin: "-20% 0px -70% 0px", threshold: 0 }
      );
      sections.forEach(function (s) {
        io.observe(s);
      });
    }

    // Initial hash
    if (location.hash) {
      setActive(location.hash.slice(1));
    }
  }

  // ── Smooth external polish: keyboard focus rings only when needed ───────
  function handleFirstTab(e) {
    if (e.key === "Tab") {
      document.body.classList.add("user-is-tabbing");
      window.removeEventListener("keydown", handleFirstTab);
    }
  }
  window.addEventListener("keydown", handleFirstTab);
})();
