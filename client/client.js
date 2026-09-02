/**
 * dsh-orchard — browser client (Punica Studio).
 *
 * Settings page "Harness 果园" (formerly dsh-harness-workbench / Harness 工作台):
 *   - Local instances: ONLY running DSH instances are listed automatically.
 *     Stopped ports never clutter the list — add a port manually if you want
 *     to keep an entry (e.g. to start it) while it is down.
 *   - Remote registry + probe/open + token-gated conversation browser across
 *     other devices running this plugin.
 */
window.__ModuleLoader__.load({ id: "dsh-orchard", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	var React = require("react");
	var h = React.createElement;

	var name = "dsh-orchard";
	var inject = ["slots"];
	var API = "/dsh-orchard/api";
	var SECTION_ID = "orchard";
	var SECTION_LABEL = "Harness 果园";
	var BRAND = "Punica Studio";
	var PINS_KEY = "dsh-harness-workbench.pins.v1";

	/* ---- pinned local ports (browser-local, surviving refresh) ---- */
	function loadPins() {
		try {
			var raw = window.localStorage.getItem(PINS_KEY);
			if (!raw) return [];
			var parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed
				.filter(function (p) { return p && Number.isInteger(Number(p.port)) && Number(p.port) > 0 && Number(p.port) < 65536; })
				.map(function (p) { return { port: Number(p.port), command: typeof p.command === "string" ? p.command : "" }; });
		}
		catch { return []; }
	}
	function savePins(list) {
		try { window.localStorage.setItem(PINS_KEY, JSON.stringify(list)); }
		catch { /* private mode */ }
	}

	function post(action, body) {
		return fetch(API + "/" + action, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body || {}),
		}).then(function (response) {
			return response.json().catch(function () { return null; });
		}).then(function (payload) {
			if (!payload || payload.ok !== true) {
				var message = (payload && payload.error) ? payload.error : "HTTP 请求失败";
				var err = new Error(message);
				throw err;
			}
			return payload;
		});
	}

	function get(path) {
		return fetch(API + "/" + path).then(function (response) {
			return response.json().catch(function () { return null; });
		}).then(function (payload) {
			if (!payload || payload.ok !== true) {
				throw new Error((payload && payload.error) ? payload.error : "读取失败");
			}
			return payload;
		});
	}

	/* ---------------- tiny UI helpers ---------------- */
	function btn(label, onClick, extra, disabled) {
		var props = { type: "button", onClick: onClick, className: "hw-btn", disabled: !!disabled };
		if (extra && extra.className) props.className = extra.className;
		if (extra && extra.title) props.title = extra.title;
		return h("button", props, label);
	}
	function dot(stateValue) {
		var color = stateValue === "up" ? "#22c55e" : stateValue === "other" ? "#eab308" : "#9ca3af";
		return h("span", { className: "hw-dot", style: { background: color } });
	}
	function fmtTime(ms) {
		if (ms === null || ms === undefined || isNaN(Number(ms)) || Number(ms) <= 0) return "—";
		return new Date(Number(ms)).toLocaleString();
	}
	function fmtSize(bytes) {
		if (!bytes) return "";
		if (bytes < 1024) return bytes + " B";
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
		return (bytes / 1024 / 1024).toFixed(1) + " MB";
	}

	/* ---------------- section content ---------------- */
	function Workbench() {
		var dataState = React.useState(null);
		var data = dataState[0];
		var setData = dataState[1];
		var errorState = React.useState("");
		var error = errorState[0];
		var setError = errorState[1];
		var busyState = React.useState(false);
		var busy = busyState[0];
		var setBusy = busyState[1];
		var draftsState = React.useState({});
		var commandDrafts = draftsState[0];
		var setCommandDrafts = draftsState[1];

		var sessionsState = React.useState({});
		var sessions = sessionsState[0];
		var setSessions = sessionsState[1];
		var transState = React.useState({});
		var transcripts = transState[0];
		var setTranscripts = transState[1];
		var openIdsState = React.useState({});
		var openIds = openIdsState[0];
		var setOpenIds = openIdsState[1];

		var pinsState = React.useState(loadPins);
		var pins = pinsState[0];
		var setPins = pinsState[1];
		var addPortState = React.useState("");
		var addPort = addPortState[0];
		var setAddPort = addPortState[1];
		var addPortCmdState = React.useState("");
		var addPortCmd = addPortCmdState[0];
		var setAddPortCmd = addPortCmdState[1];

		function persistPins(next) {
			setPins(next);
			savePins(next);
		}
		function addPinnedLocal() {
			var port = Number(addPort.trim());
			if (!Number.isInteger(port) || port <= 0 || port > 65535) { setError("请输入有效端口(1-65535)"); return; }
			var command = addPortCmd.trim();
			var next = pins.filter(function (p) { return p.port !== port; });
			next.push({ port: port, command: command });
			persistPins(next);
			if (command !== "") runAction("set-start-command", { port: port, command: command });
			setAddPort("");
			setAddPortCmd("");
			setError("");
		}
		function removePinnedLocal(port) {
			persistPins(pins.filter(function (p) { return p.port !== port; }));
		}
		/** Running auto-discovered instances + user-pinned ports (pinned stay even when down). */
		function visibleLocalRows(autoRows) {
			var byPort = new Map();
			(autoRows || [])
				.filter(function (row) { return row.alive && row.dsh; })
				.forEach(function (row) { byPort.set(row.port, row); });
			pins.forEach(function (pin) {
				var existing = byPort.get(pin.port);
				if (existing) {
					if (pin.command !== "") existing.startCommand = pin.command;
					return;
				}
				byPort.set(pin.port, {
					port: pin.port, alive: false, dsh: false, status: null, ms: null, rev: undefined,
					self: false, pid: undefined, pinned: true, startCommand: pin.command,
				});
			});
			return Array.from(byPort.values()).sort(function (a, b) { return a.port - b.port; });
		}

		function refresh(scan) {
			setBusy(true);
			setError("");
			var url = scan ? API + "/scan" : API + "/state";
			return fetch(url, scan ? { method: "POST" } : {})
				.then(function (response) { return response.json().catch(function () { return null; }); })
				.then(function (payload) {
					if (payload && payload.ok) setData(payload);
					else setError("无法读取实例状态(接口返回异常)");
				})
				.catch(function (err) { setError("状态接口不可用: " + String(err)); })
				.finally(function () { setBusy(false); });
		}
		React.useEffect(function () {
			refresh(false);
			var timer = setInterval(function () { refresh(false); }, 20000);
			return function () { clearInterval(timer); };
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);

		function runAction(action, body) {
			setBusy(true);
			setError("");
			return post(action, body)
				.then(function (payload) {
					if (payload && payload.state) setData(payload.state);
				})
				.catch(function (err) { setError(String(err.message || err)); })
				.finally(function () { setBusy(false); });
		}
		function openOrigin(originValue) { window.open(originValue, "_blank", "noopener"); }

		/* ---- session browsing ---- */
		function targetPath(target) {
			return target.kind === "remote"
				? "remote-sessions?remote=" + encodeURIComponent(target.id)
				: "local-sessions";
		}
		function transcriptPath(target, sessionId) {
			return target.kind === "remote"
				? "remote-session-content?remote=" + encodeURIComponent(target.id) + "&session=" + encodeURIComponent(sessionId)
				: "local-session-content?id=" + encodeURIComponent(sessionId);
		}
		function targetKey(target) {
			return (target.kind === "remote" ? "r:" : "l:") + (target.kind === "remote" ? target.id : "self");
		}
		function loadSessions(target, forceTitles) {
			var key = targetKey(target);
			setSessions(function (prev) {
				var current = prev[key] || {};
				if (current.loading) return prev;
				return Object.assign({}, prev, { [key]: Object.assign({}, current, { loading: true, error: "" }) });
			});
			var withTitles = (forceTitles === true) || ((sessions[key] || {}).titleDone === true);
			return get(targetPath(target) + (withTitles ? "&includeTitles=1" : ""))
				.then(function (payload) {
					setSessions(function (prev) {
						var current = prev[key] || {};
						return Object.assign({}, prev, { [key]: Object.assign({}, current, { loading: false, sessions: payload.sessions || [], titleDone: withTitles, error: "" }) });
					});
				})
				.catch(function (err) {
					setSessions(function (prev) {
						var current = prev[key] || {};
						return Object.assign({}, prev, { [key]: Object.assign({}, current, { loading: false, error: String(err.message || err) }) });
					});
				});
		}
		function toggleTranscript(target, sessionId) {
			var key = targetKey(target) + "/" + sessionId;
			setOpenIds(function (prev) {
				var next = Object.assign({}, prev);
				if (next[key]) delete next[key];
				else next[key] = true;
				return next;
			});
			var existing = transcripts[key];
			if (!existing || !existing.content) {
				setTranscripts(function (prev) {
					return Object.assign({}, prev, { [key]: { loading: true, error: "" } });
				});
				get(transcriptPath(target, sessionId))
					.then(function (payload) {
						setTranscripts(function (prev) {
							return Object.assign({}, prev, { [key]: { loading: false, content: payload } });
						});
					})
					.catch(function (err) {
						setTranscripts(function (prev) {
							return Object.assign({}, prev, { [key]: { loading: false, error: String(err.message || err) } });
						});
					});
			}
		}
		function copyText(value) {
			if (!navigator.clipboard) { setError("当前环境不支持剪贴板"); return; }
			navigator.clipboard.writeText(value).catch(function () { setError("复制失败"); });
		}
		function markdownOf(sessionId, payload) {
			var lines = [];
			var title = payload && payload.title ? payload.title : "(无标题)";
			lines.push("# 会话 " + sessionId);
			lines.push("");
			lines.push("- 标题: " + title);
			var summary = payload && payload.summary;
			if (summary && summary.createdAt) lines.push("- 创建: " + fmtTime(summary.createdAt));
			var counts = payload && payload.messageCounts;
			if (counts) lines.push("- 消息: 用户 " + counts.user + " · 助手 " + counts.assistant);
			if (payload && payload.truncated) lines.push("- 注: 日志过长,已截断显示");
			lines.push("");
			var items = (payload && payload.items) || [];
			for (var i = 0; i < items.length; i++) {
				var item = items[i];
				var when = item.time ? "(" + fmtTime(item.time) + ")" : "";
				if (item.kind === "user") { lines.push("**用户**" + when); lines.push(item.text); lines.push(""); }
				else if (item.kind === "assistant") { lines.push("**助手**" + when); lines.push(item.text); lines.push(""); }
				else if (item.kind === "tool") { lines.push("> 工具调用: " + item.name + " `" + String(item.args).slice(0, 500) + "`"); }
				else if (item.kind === "tool-result") { lines.push("> 工具结果[" + (item.name || item.callId || "?") + "]: " + String(item.preview).slice(0, 800)); }
			}
			return lines.join("\n");
		}

		/* ---- remote add form ---- */
		var addNameState = React.useState("");
		var addName = addNameState[0];
		var setAddName = addNameState[1];
		var addOriginState = React.useState("");
		var addOrigin = addOriginState[0];
		var setAddOrigin = addOriginState[1];
		var addTokenState = React.useState("");
		var addToken = addTokenState[0];
		var setAddToken = addTokenState[1];
		var serveTokenState = React.useState("");
		var serveTokenDraft = serveTokenState[0];
		var setServeTokenDraft = serveTokenState[1];

		function submitRemote(event) {
			event.preventDefault();
			if (!addOrigin.trim()) { setError("请输入远程地址"); return; }
			runAction("add-remote", { name: addName.trim(), origin: addOrigin.trim(), token: addToken.trim() })
				.then(function () { setAddName(""); setAddOrigin(""); setAddToken(""); });
		}

		if (!data) {
			return h("div", { className: "hw" },
				h("style", null, CSS),
				error ? h("div", { className: "hw-error" }, error) : null,
				h("div", { className: "hw-hint" }, busy ? "加载中…" : "正在读取实例状态…"));
		}

		var local = visibleLocalRows(data.local || []);
		var remote = data.remote || [];
		var selfPid = data.selfPid;

		/* ---- local cards (running instances + pinned ports) ---- */
		var localCards = local.map(function (item) {
			var up = item.alive && item.dsh;
			var stateKey = up ? "up" : "down";
			var originValue = "http://127.0.0.1:" + item.port + "/";
			var canStop = (data.platform === "win32") && item.alive && item.pid && item.pid !== selfPid && !item.self;
			var draft = commandDrafts[String(item.port)];
			var commandValue = draft === undefined ? (item.startCommand || "") : draft;
			var selfTarget = { kind: "local" };
			var sessKey = targetKey(selfTarget);
			var downPinned = !item.alive && item.pinned;

			return h("div", { className: "hw-card", key: "l" + item.port },
				h("div", { className: "hw-row" },
					dot(stateKey),
					h("div", { className: "hw-main" },
						h("div", { className: "hw-title" }, "127.0.0.1:" + item.port,
							item.self ? h("span", { className: "hw-badge hw-badge-self" }, "当前") : null,
							item.pinned ? h("span", { className: "hw-badge" }, "手动添加") : null,
							item.pid ? h("span", { className: "hw-meta" }, "PID " + item.pid) : null,
							item.rev ? h("span", { className: "hw-meta" }, "rev " + item.rev.slice(0, 8)) : null,
							item.alive ? h("span", { className: "hw-meta" }, item.ms + " ms") : null),
						h("div", { className: "hw-sub" },
							item.alive ? "运行中" : "未运行(仅手动添加的端口会列出)")),
					h("div", { className: "hw-actions" },
						btn("打开", function () { openOrigin(originValue); }, null, !item.alive),
						btn("复制", function () { copyText(originValue); }),
						item.self && item.alive ? btn("本机会话", function () { loadSessions(selfTarget, false); }, null, (sessions[sessKey] || {}).loading) : null,
						!item.alive ? btn("启动", function () { runAction("start-local", { port: item.port, startCommand: commandValue }); }, null, commandValue.trim() === "") : null,
						canStop ? btn("停止", function () {
							if (window.confirm("停止 127.0.0.1:" + item.port + " (PID " + item.pid + ")? 停止后如需再列出,可手动添加该端口。")) runAction("stop-local", { port: item.port });
						}, { className: "hw-btn hw-btn-danger" }) : null,
						downPinned ? btn("移除", function () {
							if (window.confirm("从列表移除端口 " + item.port + "?")) removePinnedLocal(item.port);
						}, { className: "hw-btn hw-btn-danger" }) : null)),
				!item.alive ? h("div", { className: "hw-row hw-cmdrow" },
					h("input", {
						className: "hw-input", value: commandValue, placeholder: "启动命令(可选, ${port} 会被替换)",
						onChange: function (event) {
							var next = Object.assign({}, commandDrafts);
							next[String(item.port)] = event.target.value;
							setCommandDrafts(next);
						}
					}),
					btn("保存命令", function () { runAction("set-start-command", { port: item.port, command: commandValue }); }, null, busy)) : null,
				item.self && item.alive ? sessionPanel(selfTarget, sessions, transcripts, openIds, loadSessions, toggleTranscript, markdownOf, copyText, fmtTime) : null);
		});

		/* ---- remote cards + session panels ---- */
		var remoteCards = remote.map(function (item) {
			var stateKey = item.online && item.dsh ? "up" : item.online ? "other" : "down";
			var target = { kind: "remote", id: item.id };
			var sessKey = targetKey(target);
			var sess = sessions[sessKey] || {};
			return h("div", { className: "hw-card", key: "r" + item.id },
				h("div", { className: "hw-row" },
					dot(stateKey),
					h("div", { className: "hw-main" },
						h("div", { className: "hw-title" }, item.name,
							item.hasToken ? h("span", { className: "hw-badge" }, "会话令牌已配置") : h("span", { className: "hw-badge" }, "未配令牌"),
							item.rev ? h("span", { className: "hw-meta" }, "rev " + item.rev.slice(0, 8)) : null,
							item.online ? h("span", { className: "hw-meta" }, item.ms + " ms") : null),
						h("div", { className: "hw-sub" },
							item.origin,
							!item.online ? " · 不可达" : item.dsh ? "" : " · 非 Harness 页面")),
					h("div", { className: "hw-actions" },
						btn("会话", function () { loadSessions(target, false); }, { title: "读取该设备上的会话记录(需要它在同一插件里配置 serveToken)" }, !item.online || !item.hasToken),
						btn("打开", function () { openOrigin(item.origin); }, null, !item.online),
						btn("复制", function () { copyText(item.origin); }),
						btn("移除", function () {
							if (window.confirm("移除远程实例「" + item.name + "」?")) runAction("remove-remote", { id: item.id });
						}, { className: "hw-btn hw-btn-danger" }))),
				sessionPanel(target, sessions, transcripts, openIds, loadSessions, toggleTranscript, markdownOf, copyText, fmtTime));
		});

		return h("div", { className: "hw" },
			h("style", null, CSS),
			h("div", { className: "hw-head" },
				h("div", { className: "hw-title hw-big" }, "Harness 果园", h("span", { className: "hw-meta" }, "Orchard · v" + (data.version || "?")), h("span", { className: "hw-meta" }, "by " + BRAND)),
				h("div", { className: "hw-actions" },
					btn(busy ? "刷新中…" : "刷新", function () { refresh(false); }, null, busy),
					btn("重新扫描", function () { refresh(true); }, null, busy))),
			error ? h("div", { className: "hw-error" }, error) : null,
			h("div", { className: "hw-hint" },
				"扫描范围 " + (data.range ? data.range.start + "–" + data.range.end : "?") + " · 当前 PID " + (selfPid || "?") + " · " + (data.platform || ""),
				" · 会话服务: " + (data.serveSessions ? "已开启" : "未开启")),

			h("div", { className: "hw-section" }, "本机 Harness 实例(仅显示运行中)"),
			h("form", { className: "hw-add", onSubmit: function (event) { event.preventDefault(); addPinnedLocal(); } },
				h("input", { className: "hw-input", style: { flex: "0 1 110px" }, placeholder: "端口", value: addPort, onChange: function (e) { setAddPort(e.target.value); } }),
				h("input", { className: "hw-input", style: { flex: "2 1 240px" }, placeholder: "启动命令(可选, ${port} 会被替换)", value: addPortCmd, onChange: function (e) { setAddPortCmd(e.target.value); } }),
				h("button", { className: "hw-btn", type: "submit", disabled: busy }, "手动添加端口")),
			h("div", { className: "hw-hint" }, "未运行的端口不会自动出现;需要管理/启动某个固定端口时,用它上面的表单手动添加(可选配启动命令)。"),
			localCards.length ? localCards : h("div", { className: "hw-empty" }, "没有运行中的本地实例"),

			h("div", { className: "hw-section" }, "远程 Harness"),
			h("form", { className: "hw-add", onSubmit: submitRemote },
				h("input", { className: "hw-input", style: { flex: "1 1 130px" }, placeholder: "名称(可选)", value: addName, onChange: function (e) { setAddName(e.target.value); } }),
				h("input", { className: "hw-input", style: { flex: "1 1 190px" }, placeholder: "http://主机:端口", value: addOrigin, onChange: function (e) { setAddOrigin(e.target.value); } }),
				h("input", { className: "hw-input", style: { flex: "1 1 140px" }, placeholder: "会话令牌(可选)", value: addToken, onChange: function (e) { setAddToken(e.target.value); } }),
				h("button", { className: "hw-btn", type: "submit", disabled: busy }, "添加并探测")),
			remoteCards.length ? remoteCards : h("div", { className: "hw-empty" }, "尚未添加远程 Harness"),

			h("div", { className: "hw-section" }, "允许其他设备读取本机会话"),
			h("div", { className: "hw-row hw-cmdrow" },
				h("input", {
					className: "hw-input", value: serveTokenDraft, placeholder: "共享令牌;留空并保存 = 关闭本机会话服务",
					onChange: function (e) { setServeTokenDraft(e.target.value); }
				}),
				btn("保存令牌", function () { runAction("set-serve-token", { token: serveTokenDraft.trim() }); }, null, busy)),
			h("div", { className: "hw-hint" },
				"其他设备装好本插件后:在它们的远程列表用同一令牌添加本机地址,即可读取本机历史会话;令牌请放可信网络(Tailscale/https)内传输。"),

			h("div", { className: "hw-foot" },
				"dsh-orchard " + BRAND + " · 「本机会话」= 读取当前 DSH_HOME 的会话日志。跨设备继续旧对话:打开远端 Web 界面进入原会话即可续聊(记录不会重开),或把会话复制为 Markdown 到本地新会话。"));
	}

	/* ---------------- session panel (shared) ---------------- */
	function sessionPanel(target, sessions, transcripts, openIds, loadSessions, toggleTranscript, markdownOf, copyText, fmtTime) {
		var key = (target.kind === "remote" ? "r:" : "l:") + (target.kind === "remote" ? target.id : "self");
		var sess = sessions[key] || {};

		var rows = null;
		if (sess.error) {
			rows = h("div", { className: "hw-empty hw-error" }, "读取失败: " + sess.error);
		}
		else if (!sess.sessions) {
			rows = h("div", { className: "hw-hint" }, sess.loading ? "正在读取会话列表…" : "点击「本机会话/会话」读取该设备的对话记录");
		}
		else {
			var list = (sess.sessions || []).map(function (session) {
				var tkey = key + "/" + session.id;
				var opened = !!openIds[tkey];
				var tr = transcripts[tkey] || {};
				var transcript = tr.content;
				var showTitle = session.title !== undefined ? session.title : (transcript ? transcript.title : null);
				return h("div", { className: "hw-sess", key: session.id },
					h("button", {
						className: "hw-sess-row",
						onClick: function () { toggleTranscript(target, session.id); }
					},
						h("span", { className: "hw-dot", style: { background: "transparent" } }),
						h("span", { className: "hw-main" },
							h("span", { className: "hw-title" }, showTitle ? String(showTitle).slice(0, 120) : (session.id.slice(0, 24) + "…")),
							h("span", { className: "hw-sub" },
								"更新 " + fmtTime(session.fileModifiedMs),
								session.createdAt ? " · 创建 " + fmtTime(session.createdAt) : "",
								session.bytes ? " · " + fmtSize(session.bytes) : "")),
						h("span", { className: "hw-actions" }, opened ? "收起" : "展开")),
					opened ? transcriptView(session.id, tr, markdownOf, copyText) : null);
			});
			rows = h("div", { className: "hw-sesslist" },
				h("div", { className: "hw-row" },
					h("span", { className: "hw-hint" }, "共 " + sess.sessions.length + " 个会话" + (sess.titleDone ? "" : "(未加载标题,展开可见)")),
					h("div", { className: "hw-actions" },
						sess.titleDone ? null : btn("加载全部标题", function () { loadSessions(target, true); }, null, sess.loading),
						btn("刷新", function () { loadSessions(target, true); }, null, sess.loading))),
				list);
		}
		return h("div", { className: "hw-panel" }, rows);
	}

	function transcriptView(sessionId, tr, markdownOf, copyText) {
		if (tr.loading) return h("div", { className: "hw-hint" }, "正在读取会话全文…");
		if (tr.error) return h("div", { className: "hw-empty hw-error" }, "读取失败: " + tr.error);
		var content = tr.content;
		if (!content) return null;
		var counts = content.messageCounts || {};
		var md = markdownOf(sessionId, content);
		var items = (content.items || []).map(function (item, index) {
			var when = item.time ? h("span", { className: "hw-meta" }, " " + fmtTime(item.time)) : null;
			var body = null;
			if (item.kind === "user") {
				body = h("div", { className: "hw-msg hw-msg-user" }, h("div", { className: "hw-msg-label" }, "用户", when), h("div", { className: "hw-pre" }, item.text));
			}
			else if (item.kind === "assistant") {
				var children = [h("div", { className: "hw-msg-label" }, "助手", when)];
				if (item.text) children.push(h("div", { className: "hw-pre" }, item.text));
				if (item.reasoning) children.push(h("div", { className: "hw-pre hw-reason" }, "🧠 推理: " + item.reasoning));
				body = h("div", { className: "hw-msg hw-msg-ai" }, children);
			}
			else if (item.kind === "tool") {
				body = h("div", { className: "hw-msg hw-msg-tool" }, h("div", { className: "hw-msg-label" }, "🔧 " + item.name, when), h("div", { className: "hw-pre" }, String(item.args).slice(0, 2000)));
			}
			else if (item.kind === "tool-result") {
				body = h("div", { className: "hw-msg hw-msg-tool" }, h("div", { className: "hw-msg-label" }, "↩ " + (item.name || item.callId || "工具结果"), when), h("div", { className: "hw-pre" }, String(item.preview).slice(0, 6000)));
			}
			return h("div", { key: index }, body);
		});
		var hintText = "消息: 用户 " + (counts.user ?? 0) + " · 助手 " + (counts.assistant ?? 0) + (content.truncated ? " · 过长已截断" : "");
		return h("div", { className: "hw-transcript" },
			h("div", { className: "hw-row" },
				h("div", { className: "hw-main" },
					h("div", { className: "hw-hint" }, hintText),
					h("button", { className: "hw-btn hw-btn-mini", onClick: function () { copyText(sessionId); } }, "复制会话 ID")),
				h("div", { className: "hw-actions" },
					btn("复制为 Markdown", function () { copyText(md); }))),
			items && items.length ? h("div", { className: "hw-msgs" }, items) : h("div", { className: "hw-empty" }, "(无可展示文本消息)"));
	}

	var CSS = [
		".hw{display:flex;flex-direction:column;gap:10px;max-width:920px;font-size:13px;line-height:1.5}",
		".hw-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}",
		".hw-title{display:inline-flex;align-items:center;gap:6px;font-weight:600;flex-wrap:wrap}",
		".hw-big{font-size:15px}",
		".hw-badge{display:inline-block;padding:0 6px;border-radius:999px;background:rgba(128,128,128,.18);font-size:11px}",
		".hw-badge-self{background:rgba(34,197,94,.22)}",
		".hw-meta{font-weight:400;opacity:.6;font-size:11px}",
		".hw-section{margin-top:6px;font-weight:600;border-bottom:1px solid rgba(128,128,128,.25);padding-bottom:4px}",
		".hw-card{border:1px solid rgba(128,128,128,.3);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px}",
		".hw-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
		".hw-main{flex:1;min-width:200px;display:flex;flex-direction:column;gap:2px}",
		".hw-sub{opacity:.65;font-size:12px;word-break:break-all}",
		".hw-actions{display:inline-flex;gap:6px;flex-wrap:wrap;align-items:center}",
		".hw-dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:0 0 auto}",
		".hw-btn{border:1px solid rgba(128,128,128,.4);background:transparent;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;color:inherit}",
		".hw-btn:hover:not(:disabled){background:rgba(128,128,128,.12)}",
		".hw-btn:disabled{opacity:.45;cursor:not-allowed}",
		".hw-btn-danger{border-color:rgba(239,68,68,.5);color:#ef4444}",
		".hw-btn-mini{padding:1px 6px;font-size:11px}",
		".hw-input{background:transparent;border:1px solid rgba(128,128,128,.35);border-radius:6px;padding:4px 8px;font-size:12px;color:inherit;min-width:0}",
		".hw-input:focus{outline:1px solid rgba(59,130,246,.6)}",
		".hw-add{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px}",
		".hw-error{border:1px solid rgba(239,68,68,.5);color:#ef4444;border-radius:6px;padding:6px 10px}",
		".hw-hint{opacity:.6;font-size:11px;word-break:break-all}",
		".hw-empty{opacity:.5;padding:6px 2px}",
		".hw-foot{margin-top:8px;opacity:.55;font-size:11px}",
		".hw-cmdrow{justify-content:space-between}",
		".hw-cmdrow .hw-input{flex:1}",
		".hw-panel{border-top:1px dashed rgba(128,128,128,.25);padding-top:6px;display:flex;flex-direction:column;gap:6px}",
		".hw-sesslist{display:flex;flex-direction:column;gap:4px}",
		".hw-sess{border:1px solid rgba(128,128,128,.18);border-radius:6px;overflow:hidden}",
		".hw-sess-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;padding:6px 8px;cursor:pointer;color:inherit;font-size:12px}",
		".hw-sess-row:hover{background:rgba(128,128,128,.08)}",
		".hw-transcript{border-top:1px solid rgba(128,128,128,.2);margin:0 8px 8px;padding:6px 0;display:flex;flex-direction:column;gap:8px}",
		".hw-msgs{display:flex;flex-direction:column;gap:6px;max-height:480px;overflow:auto;border:1px solid rgba(128,128,128,.15);border-radius:6px;padding:8px}",
		".hw-msg{display:flex;flex-direction:column;gap:2px;padding:4px 6px;border-radius:6px}",
		".hw-msg-user{background:rgba(59,130,246,.08)}",
		".hw-msg-ai{background:rgba(34,197,94,.06)}",
		".hw-msg-tool{background:rgba(128,128,128,.06)}",
		".hw-msg-label{font-weight:600;font-size:12px;opacity:.9}",
		".hw-pre{white-space:pre-wrap;word-break:break-word;font-size:12px}",
		".hw-reason{opacity:.55;font-size:11px}"
	].join("\n");

	function apply(ctx) {
		ctx.slots.inject("settings.section", function () {
			var off = ctx.slots.register({
				name: "settings.section",
				id: SECTION_ID,
				order: 30,
				label: function () { return SECTION_LABEL; },
			}, function (ownerProps) { return h(Workbench, {}); });
			return off;
		});
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
} });
