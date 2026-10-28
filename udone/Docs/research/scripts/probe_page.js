(() => {
  const t = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim().slice(0, 200) : "");
  const forms = Array.from(document.querySelectorAll("form")).map((f) => ({
    action: f.getAttribute("action") || "",
    method: (f.getAttribute("method") || "GET").toUpperCase(),
    enctype: f.getAttribute("enctype") || "",
    id: f.id || "",
    fields: Array.from(f.querySelectorAll("input,select,textarea")).map((i) => {
      const o = {
        tag: i.tagName, name: i.name || "", type: i.type || "", id: i.id || "",
        required: !!i.required, disabled: !!i.disabled, readonly: !!i.readOnly,
        value: (i.type === "hidden" || i.type === "password") ? "[REDACTED]" : (i.value || "").slice(0, 120),
        placeholder: i.placeholder || "",
      };
      if (i.tagName === "SELECT") {
        o.options = Array.from(i.options).map((x) => ({ v: x.value, t: t(x) })).slice(0, 40);
      }
      if (i.tagName === "INPUT" && (i.type === "checkbox" || i.type === "radio")) {
        o.checked = !!i.checked;
      }
      const lab = i.closest("label") || (i.id ? document.querySelector(`label[for="${i.id}"]`) : null);
      o.label = lab ? t(lab) : "";
      return o;
    }),
    buttons: Array.from(f.querySelectorAll("button")).map((b) => ({ t: t(b), type: b.type, cls: b.className })),
  }));
  const tables = Array.from(document.querySelectorAll("table")).map((tb) => ({
    headers: Array.from(tb.querySelectorAll("thead th")).map(t),
    rows: tb.querySelectorAll("tbody tr").length,
    sample: Array.from(tb.querySelectorAll("tbody tr")).slice(0, 5).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => t(td))
    ),
  }));
  const buttons = Array.from(document.querySelectorAll("button, a.btn, [data-bs-toggle]"))
    .map((b) => ({ tag: b.tagName, t: t(b).slice(0, 60), cls: (b.className || "").slice(0, 80), href: b.getAttribute("href") || "", toggle: b.getAttribute("data-bs-toggle") || "", target: b.getAttribute("data-bs-target") || "" }))
    .filter((b) => b.t);
  const nav = Array.from(document.querySelectorAll("a[href]"))
    .map((a) => ({ t: t(a).slice(0, 40), href: a.getAttribute("href") }))
    .filter((a) => a.href && !a.href.startsWith("#") && !a.href.startsWith("javascript"));
  const modals = Array.from(document.querySelectorAll(".modal")).map((m) => ({
    id: m.id, title: t(m.querySelector(".modal-title")),
    fields: Array.from(m.querySelectorAll("input,select,textarea")).map((i) => ({ name: i.name, type: i.type, required: !!i.required })),
  }));
  const pills = Array.from(document.querySelectorAll("[role=tab], .nav-link, .nav-pills a, .btn-group .btn")).map(t).filter(Boolean);
  return JSON.stringify({
    url: location.href, title: document.title,
    heading: t(document.querySelector("h1,h2,.page-title,.content-header h1")),
    meta: { csrf: !!document.querySelector('meta[name="csrf-token"]') },
    text: document.body.innerText.slice(0, 4000),
    forms, tables, buttons, modals,
    nav: nav.slice(0, 120), pills: pills.slice(0, 40),
  }, null, 1);
})()
