// Public theme boot for the landing, login, and cut sheet. Runs from <head>
// before first paint. The choice is stored under one key on every page.
(function () {
  var KEY = "dropcut-theme";
  var root = document.documentElement;

  function stored() {
    try {
      var value = localStorage.getItem(KEY);
      if (value === "light" || value === "dark") return value;
    } catch (e) {}
    return null;
  }

  function system() {
    if (!window.matchMedia) return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
  }

  function current() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  apply(stored() || system());

  function sync(button) {
    var theme = current();
    button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    button.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  }

  function bind() {
    var button = document.querySelector("[data-theme-toggle]");
    if (!button || button.dataset.themeBound) return;
    button.dataset.themeBound = "1";
    sync(button);
    button.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      sync(button);
      window.dispatchEvent(new Event("dropcut-theme"));
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();

  if (window.matchMedia) {
    var media = window.matchMedia("(prefers-color-scheme: dark)");
    var follow = function () {
      if (stored()) return;
      apply(system());
      var button = document.querySelector("[data-theme-toggle]");
      if (button) sync(button);
      window.dispatchEvent(new Event("dropcut-theme"));
    };
    if (media.addEventListener) media.addEventListener("change", follow);
    else if (media.addListener) media.addListener(follow);
  }
})();
