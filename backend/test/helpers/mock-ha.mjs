// Home Assistant stand-in for the reminders tests.
//
// The endpoint shapes are taken from HA core, not guessed:
//   - todo.get_items is SupportsResponse.ONLY, so it 400s without
//     ?return_response and answers { changed_states, service_response }, keyed
//     by entity id (homeassistant/components/api/__init__.py).
//   - todo.update_item resolves its `item` field by uid OR summary
//     (_find_by_uid_or_summary) and rejects a call with nothing to change
//     (has_at_least_one_key).
import http from "http";
import crypto from "crypto";

export function startMockHa() {
  const items = [];
  const notifications = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://ha");
      const data = body ? JSON.parse(body) : {};
      const json = (code, payload) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === "/api/states") {
        return json(200, [
          { entity_id: "todo.dashboard", state: String(items.filter((i) => i.status === "needs_action").length) },
          { entity_id: "light.kitchen", state: "off" },
        ]);
      }

      if (url.pathname === "/api/services" && req.method === "GET") {
        return json(200, [
          { domain: "todo", services: { add_item: {}, update_item: {}, remove_item: {}, get_items: {} } },
          { domain: "notify", services: { notify: {}, mobile_app_test_iphone: {} } },
        ]);
      }

      const svc = /^\/api\/services\/([a-z_]+)\/([a-z0-9_]+)$/.exec(url.pathname);
      if (svc && req.method === "POST") {
        const [, domain, service] = svc;

        if (domain === "todo" && service === "get_items") {
          if (!url.searchParams.has("return_response")) {
            return json(400, { message: "Add ?return_response to query parameters." });
          }
          const statuses = data.status || ["needs_action"];
          return json(200, {
            changed_states: [],
            service_response: { "todo.dashboard": { items: items.filter((i) => statuses.includes(i.status)) } },
          });
        }

        if (domain === "todo" && service === "add_item") {
          items.push({
            uid: crypto.randomBytes(8).toString("hex"),
            summary: data.item,
            status: "needs_action",
            due: data.due_datetime || data.due_date || null,
            description: data.description || null,
          });
          return json(200, { changed_states: [] });
        }

        if (domain === "todo" && service === "update_item") {
          const it = items.find((i) => i.uid === data.item || i.summary === data.item);
          if (!it) return json(400, { message: "item not found" });
          const changing = Object.keys(data).filter((k) => k !== "entity_id" && k !== "item");
          if (!changing.length) return json(400, { message: "must have at least one key" });
          if (data.rename) it.summary = data.rename;
          if (data.status) it.status = data.status;
          if (data.description !== undefined) it.description = data.description;
          if (data.due_datetime) it.due = data.due_datetime;
          if (data.due_date) it.due = data.due_date;
          return json(200, { changed_states: [] });
        }

        if (domain === "todo" && service === "remove_item") {
          for (const t of [].concat(data.item)) {
            const idx = items.findIndex((i) => i.uid === t || i.summary === t);
            if (idx >= 0) items.splice(idx, 1);
          }
          return json(200, { changed_states: [] });
        }

        if (domain === "notify") {
          notifications.push({ service, title: data.title, message: data.message, data: data.data });
          return json(200, { changed_states: [] });
        }

        return json(400, { message: `unknown service ${domain}.${service}` });
      }

      json(404, { message: "not found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        items,
        notifications,
        reset() {
          items.length = 0;
          notifications.length = 0;
        },
        close: () => new Promise((r) => server.close(r)),
        // Injected into createRemindersClient in place of the real HA helpers.
        deps: {
          callHaService: async (domain, service, payload) => {
            const r = await fetch(`${base}/api/services/${domain}/${service}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            if (!r.ok) throw new Error(`HA service call failed: ${r.status}`);
          },
          callHaServiceForResponse: async (domain, service, payload) => {
            const r = await fetch(`${base}/api/services/${domain}/${service}?return_response`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            if (!r.ok) throw new Error(`HA service call failed: ${r.status}`);
            return r.json();
          },
          getStates: async () => (await fetch(`${base}/api/states`)).json(),
          listServices: async () => (await fetch(`${base}/api/services`)).json(),
        },
      });
    });
  });
}
