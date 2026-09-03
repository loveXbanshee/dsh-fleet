/**
 * dsh-fleet — browser client (Punica Studio).
 *
 * Settings page "Harness Fleet" (formerly dsh-harness-workbench / Harness 工作台):
 *   - Local instances: ONLY running DSH instances are listed automatically.
 *     Stopped ports never clutter the list — add a port manually if you want
 *     to keep an entry (e.g. to start it) while it is down.
 *   - Remote registry + probe/open + token-gated conversation browser across
 *     other devices running this plugin.
 */
window.__ModuleLoader__.load({ id: "dsh-fleet", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	var React = require("react");
	var h = React.createElement;

	var name = "dsh-fleet";
	var inject = ["slots"];
	var API = "/dsh-fleet/api";
	var SECTION_ID = "orchard";
	var SECTION_LABEL = "Harness Fleet";
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
		var addInsecureState = React.useState(false);
		var addInsecure = addInsecureState[0];
		var setAddInsecure = addInsecureState[1];
		var serveTokenState = React.useState("");
		var serveTokenDraft = serveTokenState[0];
		var setServeTokenDraft = serveTokenState[1];

		/* ---- fleet gateway settings (drafts; live status comes from data.gateway) ---- */
		var gwEnableState = React.useState(false);
		var gwEnable = gwEnableState[0];
		var setGwEnable = gwEnableState[1];
		var gwPortState = React.useState("");
		var gwPort = gwPortState[0];
		var setGwPort = gwPortState[1];
		var gwHostState = React.useState("");
		var gwHost = gwHostState[0];
		var setGwHost = gwHostState[1];
		React.useEffect(function () {
			if (!data || !data.gateway) return;
			setGwEnable(!!data.gateway.configured);
			setGwPort(String(data.gateway.port));
			setGwHost(String(data.gateway.host));
		}, [data && data.gateway ? data.gateway.port : 0, data && data.gateway ? data.gateway.host : "", data && data.gateway ? data.gateway.configured : false]);

		/* ---- test-stage self-update ---- */
		var updateInfoState = React.useState(null);
		var updateInfo = updateInfoState[0];
		var setUpdateInfo = updateInfoState[1];
		var updateBusyState = React.useState(false);
		var updateBusy = updateBusyState[0];
		var setUpdateBusy = updateBusyState[1];
		var updateMsgState = React.useState("");
		var updateMsg = updateMsgState[0];
		var setUpdateMsg = updateMsgState[1];
		var checkedOnceState = React.useState(false);
		var checkedOnce = checkedOnceState[0];
		var setCheckedOnce = checkedOnceState[1];

		function doUpdateCheck(force) {
			setUpdateBusy(true);
			setUpdateMsg("");
			return get("update-check" + (force ? "?force=1" : ""))
				.then(function (payload) { setUpdateInfo(payload); })
				.catch(function (err) { setUpdateInfo({ ok: false, error: String(err.message || err) }); })
				.finally(function () { setUpdateBusy(false); });
		}
		React.useEffect(function () {
			if (!checkedOnce && data) {
				setCheckedOnce(true);
				doUpdateCheck(false);
			}
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [data, checkedOnce]);

		function doSelfUpdate() {
			setUpdateBusy(true);
			setUpdateMsg("正在从 GitHub 拉取最新代码…");
			setError("");
			return post("self-update", {})
				.then(function (payload) {
					if (payload && payload.updated) {
						setUpdateInfo({ ok: true, current: payload.current, latest: payload.latest, updateAvailable: false });
						setUpdateBusy(false);
						setUpdateMsg("新代码已拉取,即将自动重启生效(约 10 秒后恢复,请刷新页面)…");
						window.setTimeout(function () {
							fetch(API + "/restart", { method: "POST" })
								.then(function () { setUpdateMsg("重启指令已发出;页面断开后请稍等并刷新。"); })
								.catch(function () { setUpdateMsg("重启指令发送失败 — 请手动重启 dsh web 完成更新。"); });
						}, 1200);
					}
					else {
						setUpdateInfo({ ok: true, current: payload && payload.current, latest: payload && payload.latest, updateAvailable: false });
						setUpdateBusy(false);
						setUpdateMsg("已是最新版本,无需更新。");
					}
				})
				.catch(function (err) {
					setUpdateBusy(false);
					setUpdateMsg("更新失败: " + String(err.message || err) + " — 请确认该设备能访问 github.com 且装有 pnpm。");
				});
		}

		function submitRemote(event) {
			event.preventDefault();
			if (!addOrigin.trim()) { setError("请输入远程地址"); return; }
			runAction("add-remote", { name: addName.trim(), origin: addOrigin.trim(), token: addToken.trim(), insecure: addInsecure })
				.then(function () { setAddName(""); setAddOrigin(""); setAddToken(""); setAddInsecure(false); });
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
			var okOnline = item.online && (item.dsh || item.gateway);
			var stateKey = okOnline ? "up" : item.online ? "other" : "down";
			var target = { kind: "remote", id: item.id };
			var sessKey = targetKey(target);
			var sess = sessions[sessKey] || {};
			var isHttps = /^https:\/\//i.test(item.origin);
			var isCertErr = !item.online && /CERT|SELF_SIGNED|UNABLE_TO_GET_ISSUER/i.test(item.error || "");
			return h("div", { className: "hw-card", key: "r" + item.id },
				h("div", { className: "hw-row" },
					dot(stateKey),
					h("div", { className: "hw-main" },
						h("div", { className: "hw-title" }, item.name,
							item.gateway ? h("span", { className: "hw-badge hw-badge-self" }, "Fleet 网关") : null,
							item.insecure ? h("span", { className: "hw-badge" }, "信任自签证书") : null,
							item.hasToken ? h("span", { className: "hw-badge" }, "会话令牌已配置") : h("span", { className: "hw-badge" }, "未配令牌"),
							item.rev ? h("span", { className: "hw-meta" }, "rev " + item.rev.slice(0, 8)) : null,
							item.online ? h("span", { className: "hw-meta" }, item.ms + " ms") : null),
						h("div", { className: "hw-sub" },
							item.origin,
							item.online ? (item.dsh ? "" : item.gateway ? " · Fleet 网关(会话可读)" : " · 非 Harness 页面")
								: (isCertErr ? " · 证书不受信任(" + item.error + ") — 该地址是自签 https,点「信任自签证书」即可放行"
									: " · 不可达" + (item.error && item.error !== "unreachable" ? " (" + item.error + ")" : "") + " — 请在目标设备开启 Fleet 网关,或让 dsh 绑定局域网IP/隧道;地址不要用 127.0.0.1"))),
					h("div", { className: "hw-actions" },
						btn("会话", function () { loadSessions(target, false); }, { title: "读取该设备上的会话记录(需要它在同一插件里配置 serveToken)" }, !okOnline || !item.hasToken),
						btn("窗口内打开", function () { fleetOpenDevice({ id: item.id, name: item.name, origin: item.origin }); }, { title: "在当前窗口内嵌打开该设备 dsh(可继续对话)" }, !item.online),
						btn("新页打开", function () { openOrigin(item.origin); }, null, !item.online),
						btn("复制", function () { copyText(item.origin); }),
						isHttps ? (item.insecure
							? btn("取消信任自签", function () { runAction("set-remote-insecure", { id: item.id, insecure: false }).then(function () { refresh(true); }); }, null, busy)
							: btn(isCertErr ? "信任自签证书并重试" : "信任自签证书", function () { runAction("set-remote-insecure", { id: item.id, insecure: true }).then(function () { refresh(true); }); }, { className: "hw-btn hw-btn-warn" }, busy))
							: null,
						btn("移除", function () {
							if (window.confirm("移除远程实例「" + item.name + "」?")) runAction("remove-remote", { id: item.id });
						}, { className: "hw-btn hw-btn-danger" }))),
				sessionPanel(target, sessions, transcripts, openIds, loadSessions, toggleTranscript, markdownOf, copyText, fmtTime));
		});

		return h("div", { className: "hw" },
			h("style", null, CSS),
			h("div", { className: "hw-head" },
				h("div", { className: "hw-title hw-big" }, "Harness Fleet", h("span", { className: "hw-meta" }, "Fleet · v" + (data.version || "?")), h("span", { className: "hw-meta" }, "by " + BRAND)),
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
				h("label", { className: "hw-row", style: { gap: "6px", flex: "0 1 auto" } },
					h("input", { type: "checkbox", checked: addInsecure, onChange: function (e) { setAddInsecure(e.target.checked); } }),
					h("span", { className: "hw-hint" }, "信任自签 https")),
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

			h("div", { className: "hw-section" }, "Fleet 网关(局域网直读会话)"),
			h("div", { className: "hw-row hw-cmdrow" },
				h("label", { className: "hw-row", style: { gap: "6px", flex: "0 1 auto", margin: 0 } },
					h("input", { type: "checkbox", checked: gwEnable, onChange: function (e) { setGwEnable(e.target.checked); } }),
					h("span", null, "启用只读网关(默认关闭)")),
				h("span", { className: "hw-hint" }, "端口"),
				h("input", { className: "hw-input", style: { flex: "0 1 90px" }, value: gwPort, placeholder: "33180", onChange: function (e) { setGwPort(e.target.value); } }),
				h("span", { className: "hw-hint" }, "绑定"),
				h("input", { className: "hw-input", style: { flex: "0 1 130px" }, value: gwHost, placeholder: "0.0.0.0", onChange: function (e) { setGwHost(e.target.value); } }),
				btn("保存网关设置", function () {
					runAction("set-gateway", { enabled: gwEnable, port: Number(gwPort) || undefined, host: gwHost.trim() || "0.0.0.0" });
				}, null, busy)),
			h("div", { className: "hw-hint" },
				((data.gateway && data.gateway.listening) ? ("● 监听中 " + data.gateway.host + ":" + data.gateway.port) : (data.gateway && data.gateway.configured) ? ("未监听" + (data.gateway.error ? "(" + data.gateway.error + ")" : (data.serveSessions ? "" : " — 请先在上方设置共享令牌")) + " — 检查端口占用/防火墙") : "未启用"),
				" · 网关只暴露「会话索引/全文」两个端点并强制要求 serveToken,无任何修改操作;启用后其他机器用「本机局域网IP:该端口」作为远程地址即可读取(免绑 dsh、免命令行)。Windows 首次需在防火墙弹窗点「允许访问」。" + (data.gateway && data.gateway.configured && !data.gateway.listening ? " 若提示端口占用可换端口保存。" : "")),

			h("div", { className: "hw-section" }, "关于 · 测试期更新"),
			h("div", { className: "hw-row" },
				h("div", { className: "hw-main" },
					h("div", { className: "hw-title" }, "dsh-fleet", h("span", { className: "hw-meta" }, "当前 v" + (data.version || "?")), updateInfo && updateInfo.latest ? h("span", { className: "hw-meta" }, "GitHub 最新 v" + updateInfo.latest) : null),
					h("div", { className: "hw-hint" },
						updateMsg !== "" ? updateMsg
							: !updateInfo ? (updateBusy ? "正在检查更新…" : "点击「检查更新」查看 GitHub 最新版本")
							: !updateInfo.ok ? ("更新检查失败: " + updateInfo.error)
							: updateInfo.updateAvailable ? ("发现新版本 v" + updateInfo.latest + " — 点击「更新并重启」将从 GitHub 拉取新代码并自动重启生效。")
							: "已是最新版本。")),
				h("div", { className: "hw-actions" },
					btn(updateBusy ? "检查中…" : "检查更新", function () { doUpdateCheck(true); }, null, updateBusy),
					updateInfo && updateInfo.updateAvailable && !updateBusy
						? btn("更新并重启", function () { doSelfUpdate(); }, { className: "hw-btn hw-btn-primary" }, updateBusy)
						: null)),
			h("div", { className: "hw-hint" }, "测试期版本迭代频繁:任一设备检测到新版后可在此一键更新(插件宿主自动执行 pnpm add github:loveXbanshee/dsh-fleet,完成后自动重启 dsh web)。非 Windows 需手动重启。"),

			h("div", { className: "hw-foot" },
				"dsh-fleet " + BRAND + " · 「本机会话」= 读取当前 DSH_HOME 的会话日志。跨设备继续旧对话:打开远端 Web 界面进入原会话即可续聊(记录不会重开),或把会话复制为 Markdown 到本地新会话。"));
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
		".hw-btn-warn{border-color:rgba(234,179,8,.6);color:#ca8a04}",
		".hw-btn-primary{border-color:rgba(34,197,94,.6);color:#16a34a;font-weight:600}",
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
		".hw-reason{opacity:.55;font-size:11px}",
		".hw-fleet{display:flex;flex-direction:column;gap:6px;padding:6px 8px;min-width:0}",
		".hw-sidebtn{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer}",
		".hw-sidebtn:hover{background:rgba(128,128,128,.12)}",
		".hw-chipbar{display:flex;flex-direction:column;gap:4px;min-width:0}",
		".hw-chipbar-inline{flex-direction:row;flex-wrap:wrap;gap:6px;align-items:center}",
		".hw-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(128,128,128,.28);background:transparent;color:inherit;border-radius:999px;padding:3px 10px 3px 6px;font-size:12px;cursor:pointer;min-width:0}",
		".hw-chip:hover{background:rgba(128,128,128,.12)}",
		".hw-chip-busy .hw-dot{animation:hwPulse 1.1s ease-in-out infinite}",
		".hw-chip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}",
		".hw-chip-flag{font-size:11px;opacity:.85}",
		"@keyframes hwPulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}50%{box-shadow:0 0 0 5px rgba(34,197,94,0)}}",
		".hw-overlay{position:fixed;inset:0;z-index:2147483000;background:#0f1115;color:#e8e8ec;display:flex;flex-direction:column}",
		".hw-overlay-bar{display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.12);flex-wrap:wrap}",
		".hw-overlay-title{font-weight:600;font-size:14px}",
		".hw-frame{flex:1;border:0;background:#fff}",
		".hw-overlay-empty{padding:32px;text-align:center;color:#9ca3af}",
		".hw-sbtree{display:flex;flex-direction:column;gap:2px;padding:8px 6px;min-width:0;max-height:100%;overflow:auto}",
		".hw-sbtree-rail{align-items:center;gap:6px;overflow:visible}",
		".hw-sb-head{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:700;opacity:.7;text-transform:uppercase;letter-spacing:.03em;padding:6px 4px 2px}",
		".hw-sb-group{display:flex;flex-direction:column}",
		".hw-sb-node{display:flex;align-items:center;gap:5px;width:100%;text-align:left;background:transparent;border:0;color:inherit;padding:4px 4px;border-radius:6px;cursor:pointer;font-size:12px;min-width:0}",
		".hw-sb-node:hover{background:rgba(128,128,128,.12)}",
		".hw-sb-open{font-weight:600}",
		".hw-sb-caret{flex:0 0 auto;width:12px;opacity:.7;font-size:10px}",
		".hw-sb-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		".hw-sb-count{flex:0 0 auto;font-size:10px;opacity:.55;margin-left:4px}",
		".hw-sb-tag{flex:0 0 auto;font-size:9px;padding:0 4px;border-radius:6px;background:rgba(128,128,128,.16);opacity:.9}",
		".hw-sb-children{display:flex;flex-direction:column;margin-left:14px;padding-left:6px;border-left:1px solid rgba(128,128,128,.18)}",
		".hw-sb-leaf{display:flex;align-items:center;gap:5px;width:100%;text-align:left;background:transparent;border:0;color:inherit;padding:3px 4px;border-radius:6px;cursor:pointer;font-size:12px;min-width:0}",
		".hw-sb-leaf:hover{background:rgba(128,128,128,.1)}",
		".hw-sb-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block}",
		".hw-sb-empty{font-size:11px;opacity:.5;padding:2px 6px}",
		".hw-sb-railbtn{border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;padding:0}",
		".hw-sb-railbtn:hover{background:rgba(128,128,128,.14)}",
		".hw-sb-pulse{animation:hwPulse 1.2s ease-in-out infinite}",
		".hw-sb-idle{animation:none}"
	].join("\n");

	/* ---------------- cross-component fleet store ---------------- */
	var fleetStore = { open: false, device: null, listeners: [], services: null };
	function fleetNotify() {
		for (var i = 0; i < fleetStore.listeners.length; i += 1) { try { fleetStore.listeners[i](); } catch (e) { /* ignore */ } }
	}
	function fleetOpenDevice(device) { fleetStore.device = device || null; fleetStore.open = true; fleetNotify(); }
	function fleetClose() { fleetStore.open = false; fleetNotify(); }
	function fleetPickDevice(device) { fleetStore.device = device; fleetNotify(); }
	function useFleetStore() {
		var pair = React.useState(Object.assign({}, fleetStore));
		var setStore = pair[1];
		React.useEffect(function () {
			var update = function () { setStore(Object.assign({}, fleetStore)); };
			fleetStore.listeners.push(update);
			return function () { fleetStore.listeners = fleetStore.listeners.filter(function (fn) { return fn !== update; }); };
		}, []);
		return pair[0];
	}

	function FleetChip(props) {
		var device = props.device;
		var activity = props.activity;
		var busy = !!(activity && activity.busy);
		var color = !activity ? '#9ca3af' : activity.offline ? '#9ca3af' : activity.failed ? '#ef4444' : '#22c55e';
		var title = device.origin + (busy ? '\n● 正在运行' : (activity && activity.justFinished ? '\n✓ 刚完成' : (activity && activity.offline ? '\n离线/不可达' : '\n空闲')));
		return h("button", {
			className: "hw-chip" + (busy ? " hw-chip-busy" : ""),
			onClick: props.onClick,
			title: title,
			style: { color: color }
		},
			h("span", { className: "hw-dot", style: { background: color } }),
			h("span", { className: "hw-chip-name" }, device.name || device.origin),
			busy ? h("span", { className: "hw-chip-flag" }, "运行中") : (activity && activity.justFinished ? h("span", { className: "hw-chip-flag" }, "✓") : null));
	}

	/** Always-visible sidebar footer strip: open remote view + per-device live dots. */
	function FleetSide() {
		var store = useFleetStore();
		var remoteState = React.useState(null);
		var remotes = remoteState[0];
		var setRemotes = remoteState[1];
		var actState = React.useState({});
		var acts = actState[0];
		var setActs = actState[1];
		React.useEffect(function () {
			var alive = true;
			var timer = null;
			function refresh() {
				get("state").then(function (payload) {
					if (!alive) return;
					var list = payload.remote || [];
					setRemotes(list);
					var next = {};
					var jobs = [];
					list.forEach(function (remote) {
						if (!remote.online || !remote.hasToken) {
							next[remote.id] = { offline: !remote.online, busy: false, justFinished: false };
							return;
						}
						jobs.push(get("remote-sessions?remote=" + encodeURIComponent(remote.id))
							.then(function (page) {
								var newest = 0;
								(page.sessions || []).forEach(function (entry) { if ((entry.fileModifiedMs || 0) > newest) newest = entry.fileModifiedMs; });
								var age = Date.now() - newest;
								next[remote.id] = { busy: age < 45000, offline: false, justFinished: false };
							})
							.catch(function () { next[remote.id] = { busy: false, offline: true, justFinished: false }; }));
					});
					return Promise.all(jobs).then(function () { if (alive) setActs(next); }).catch(function () { if (alive) setActs(next); });
				}).catch(function () { /* transient */ });
			}
			refresh();
			timer = setInterval(refresh, 8000);
			return function () { alive = false; if (timer) clearInterval(timer); };
		}, []);

		var openButton = h("button", { className: "hw-sidebtn", title: "在当前窗口内打开/切换远程 dsh", onClick: function () { fleetOpenDevice(null); } },
			h("span", { className: "hw-dot", style: { background: "#3b82f6" } }),
			"远程设备");
		var chips = (remotes && remotes.length > 0)
			? h("div", { className: "hw-chipbar" }, remotes.map(function (remote) {
				return h(FleetChip, { key: remote.id, device: remote, activity: acts[remote.id], onClick: function () { fleetOpenDevice({ id: remote.id, name: remote.name, origin: remote.origin }); } });
			}))
			: null;
		return h("div", { className: "hw-fleet" }, h("style", null, CSS), openButton, chips);
	}

	/** Full-window in-app view: pick a remote device, then iframe its dsh UI. */
	function FleetOverlay() {
		var store = useFleetStore();
		var devicesState = React.useState(null);
		var devices = devicesState[0];
		var setDevices = devicesState[1];
		var errState = React.useState("");
		var err = errState[0];
		var setErr = errState[1];
		React.useEffect(function () {
			if (!store.open) return;
			var alive = true;
			function load() {
				get("state").then(function (payload) { if (alive) setDevices(payload.remote || []); })
					.catch(function (error) { setErr(String((error && error.message) || error)); });
			}
			load();
			var timer = setInterval(load, 10000);
			return function () { alive = false; clearInterval(timer); };
		}, [store.open]);
		if (!store.open) return null;
		var bar = h("div", { className: "hw-overlay-bar" },
			h("button", { className: "hw-btn", onClick: fleetClose }, "✕ 返回本机"),
			h("span", { className: "hw-overlay-title" }, "远程 dsh(窗口内)"),
			h("div", { className: "hw-chipbar hw-chipbar-inline" },
				(devices || []).map(function (remote) {
					return h(FleetChip, { key: remote.id, device: remote, activity: null, onClick: function () { fleetPickDevice({ id: remote.id, name: remote.name, origin: remote.origin }); } });
				})));
		var body;
		if (store.device) {
			body = h("iframe", { key: store.device.origin, src: store.device.origin, className: "hw-frame", title: (store.device.name || "remote dsh") });
		}
		else if (devices && devices.length > 0) {
			body = h("div", { className: "hw-overlay-empty" }, "请在上方选择要打开的远程设备(点击即在本窗口打开,可继续对话)");
		}
		else {
			body = h("div", { className: "hw-overlay-empty" }, err ? ("加载失败: " + err) : "暂无已配置的远程设备 — 请到 设置 → Harness Fleet 添加并配置令牌");
		}
		return h("div", { className: "hw-overlay" }, h("style", null, CSS), bar, body);
	}

	/* ---------------- composite sidebar: local workspaces + remote tree ---------------- */

	function FleetWorkspaceBrowser(props) {
		var wide = props && props.wide !== undefined ? props.wide : true;
		var expandSidebar = props && props.expandSidebar ? props.expandSidebar : function () {};
		var modelState = React.useState(null);
		var model = modelState[0];
		var setModel = modelState[1];
		var openState = React.useState({});
		var opened = openState[0];
		var setOpened = openState[1];

		function toggleOpen(key) {
			setOpened(function (prev) {
				var next = Object.assign({}, prev);
				next[key] = !prev[key];
				return next;
			});
		}

		React.useEffect(function () {
			var alive = true;
			var timer = null;
			async function load() {
				var localList = [];
				try {
					var page = await get("local-sessions?includeTitles=1");
					var groups = new Map();
					(page.sessions || []).forEach(function (s) {
						var key = s.cwd || "(无目录)";
						if (!groups.has(key)) groups.set(key, { cwd: key, sessions: [] });
						groups.get(key).sessions.push(s);
					});
					localList = Array.from(groups.values()).map(function (g) {
						var parts = String(g.cwd).replace(/\\/g, "/").split("/").filter(Boolean);
						return { cwd: g.cwd, name: parts.length > 0 ? parts[parts.length - 1] : g.cwd, sessions: (g.sessions || []).sort(function (a, b) { return (b.fileModifiedMs || 0) - (a.fileModifiedMs || 0); }) };
					}).sort(function (a, b) { return a.name.localeCompare(b.name); });
				}
				catch (e) { /* ignore */ }

				var remoteRows = [];
				try {
					var st = await get("state");
					var devices = st.remote || [];
					var states = [];
					for (var i = 0; i < devices.length; i += 1) {
						var device = devices[i];
						var sessions = [];
						var busy = false;
						var err = device.online ? undefined : (device.error || "offline");
						if (device.online && device.hasToken) {
							try {
								var rs = await get("remote-sessions?remote=" + encodeURIComponent(device.id) + "&includeTitles=1");
								sessions = rs.sessions || [];
								var newest = 0;
								sessions.forEach(function (s) { if ((s.fileModifiedMs || 0) > newest) newest = s.fileModifiedMs; });
								busy = (Date.now() - newest) < 45000;
							}
							catch (e2) { err = String((e2 && e2.message) || e2); }
						}
						states.push({ id: device.id, name: device.name, origin: device.origin, online: device.online, hasToken: device.hasToken, busy: busy, error: err, sessions: sessions });
					}
					remoteRows = states;
				}
				catch (e3) { /* ignore */ }
				if (alive) setModel({ local: localList, remotes: remoteRows, at: Date.now() });
			}
			load();
			timer = setInterval(load, 20000);
			return function () { alive = false; if (timer) clearInterval(timer); };
		}, []);

		function openLocalSession(id) {
			var svc = fleetStore.services && fleetStore.services.sessions;
			if (svc && typeof svc.open === "function") { try { svc.open(id); } catch (e) { /* ignore */ } }
		}

		if (!wide) {
			return h("div", { className: "hw-sbtree hw-sbtree-rail" },
				h("style", null, CSS),
				h("button", { className: "hw-sb-railbtn", title: "展开侧栏查看本机/远程会话", onClick: expandSidebar }, "⇔"),
				((model && model.remotes) || []).map(function (device) {
					var color = !device.online ? "#9ca3af" : "#22c55e";
					return h("button", { key: device.id, className: "hw-sb-railbtn" + (device.busy ? " hw-sb-busy" : ""), title: device.name + (device.busy ? " · 运行中" : device.online ? "" : " · 离线"), style: { color: color }, onClick: expandSidebar }, (device.name ? String(device.name).charAt(0).toUpperCase() : "R"));
				}));
		}

		var localRows = (model && model.local || []).map(function (ws) {
			var key = "ws:" + ws.cwd;
			var isOpen = !!opened[key];
			var sessions = ws.sessions || [];
			return h("div", { key: key, className: "hw-sb-group" },
				h("button", { className: "hw-sb-node" + (isOpen ? " hw-sb-open" : ""), onClick: function () { toggleOpen(key); }, title: ws.cwd },
					h("span", { className: "hw-sb-caret" }, isOpen ? "▾" : "▸"),
					h("span", { className: "hw-sb-name" }, ws.name || "(无目录)"),
					h("span", { className: "hw-sb-count" }, sessions.length)),
				isOpen ? h("div", { className: "hw-sb-children" }, sessions.length ? sessions.map(function (session) {
					var title = session.title || (session.id ? session.id.slice(0, 24) + "…" : "?");
					return h("button", { key: session.id, className: "hw-sb-leaf", title: session.id + "\n更新 " + fmtTime(session.fileModifiedMs), onClick: function () { openLocalSession(session.id); } },
						h("span", { className: "hw-sb-dot", style: { background: "#3b82f6" } }),
						h("span", { className: "hw-sb-name" }, String(title).slice(0, 90)),
						h("span", { className: "hw-sb-count" }, fmtTime(session.fileModifiedMs).slice(5, 16)));
				}) : h("div", { className: "hw-sb-empty" }, "该工作区暂无会话")) : null);
		});

		var remoteRows = (model && model.remotes || []).map(function (device) {
			var key = "dev:" + device.id;
			var isOpen = !!opened[key];
			var color = device.online ? "#22c55e" : "#9ca3af";
			return h("div", { key: key, className: "hw-sb-group" },
				h("button", { className: "hw-sb-node" + (isOpen ? " hw-sb-open" : ""), onClick: function () { toggleOpen(key); }, title: device.origin },
					h("span", { className: "hw-sb-caret" }, isOpen ? "▾" : "▸"),
					h("span", { className: "hw-dot hw-sb-pulse" + (device.busy ? "" : " hw-sb-idle"), style: { background: color } }),
					h("span", { className: "hw-sb-name" }, device.name || device.origin),
					device.busy ? h("span", { className: "hw-sb-tag" }, "运行中") : (!device.online ? h("span", { className: "hw-sb-tag" }, "离线") : null),
					device.hasToken ? null : h("span", { className: "hw-sb-tag" }, "无令牌")),
				isOpen ? h("div", { className: "hw-sb-children" },
					device.sessions && device.sessions.length ? device.sessions.map(function (session) {
						var title = session.title || (session.id ? session.id.slice(0, 24) + "…" : "?");
						return h("button", { key: session.id, className: "hw-sb-leaf", title: "点开在窗口内打开该设备 dsh\n" + session.id + "\n更新 " + fmtTime(session.fileModifiedMs), onClick: function () { fleetOpenDevice({ id: device.id, name: device.name, origin: device.origin }); } },
							h("span", { className: "hw-sb-dot", style: { background: "#a78bfa" } }),
							h("span", { className: "hw-sb-name" }, String(title).slice(0, 90)),
							h("span", { className: "hw-sb-count" }, fmtTime(session.fileModifiedMs).slice(5, 16)));
					}) : h("div", { className: "hw-sb-empty" }, !device.online ? "设备不可达" : device.hasToken ? "该设备暂无会话" : "未配令牌,无法读取会话"))
				: null);
		});

		return h("div", { className: "hw-sbtree" },
			h("style", null, CSS),
			h("div", { className: "hw-sb-head" }, "工作区", model ? h("span", { className: "hw-sb-count" }, "刷新 " + fmtTime(model.at).slice(5, 16)) : null),
			localRows.length ? localRows : h("div", { className: "hw-sb-empty" }, "暂无本机会话"),
			h("div", { className: "hw-sb-head" }, "远程设备"),
			remoteRows.length ? remoteRows : h("div", { className: "hw-sb-empty" }, "未配置远程设备(设置 → Harness Fleet 添加)"));
	}

	function apply(ctx) {
		fleetStore.services = {
			sessions: ctx.get("sessions"),
			workspaces: ctx.get("workspaces"),
			layout: ctx.get("layout"),
		};
		ctx.slots.inject("sidebar.workspaces", function () {
			return ctx.slots.register({ name: "sidebar.workspaces" }, function (ownerProps) { return h(FleetWorkspaceBrowser, ownerProps); });
		});
		ctx.slots.inject("settings.section", function () {
			var off = ctx.slots.register({
				name: "settings.section",
				id: SECTION_ID,
				order: 30,
				label: function () { return SECTION_LABEL; },
			}, function (ownerProps) { return h(Workbench, {}); });
			return off;
		});
		ctx.slots.inject("sidebar.footer.action", function () {
			return ctx.slots.register({
				name: "sidebar.footer.action",
				id: "fleet-remote-open",
				order: 5,
				label: function () { return "远程设备"; },
			}, function () { return h(FleetSide, {}); });
		});
		ctx.slots.inject("shell.overlay", function () {
			return ctx.slots.register({
				name: "shell.overlay",
				id: "fleet-remote-view",
				order: 5,
				label: function () { return "Fleet 远程 dsh"; },
			}, function () { return h(FleetOverlay, {}); });
		});
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
} });
