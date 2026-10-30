/**
 * dsh-cheerful — 浏览器半边。
 *
 * 两件事，都挂在 dsh Web 客户端的 slot 上：
 *  1. `shell.overlay`：整帧浮层里的一层 canvas，负责画左右两门礼炮、礼炮喷出的彩带与中央庆祝文案。
 *  2. `tool.call.toolview` 的 `cheer` 键：把 cheer 工具调用渲染成一张小卡片；
 *     只有"本次实时调用"会触发礼炮，历史会话回放不会重放（见 useCheerTrigger 的判定）。
 *
 * 触发链路是纯客户端的：Host 工具执行完 → 会话把 tool call 投影到客户端 →
 * 本模块的 toolview 观察到 result 阶段 → 通过模块内总线通知浮层播放。
 * 不写自定义会话事件，所以不会影响会话 resume。
 *
 * @module dsh-cheerful
 */

window.__ModuleLoader__.load({
	id: "dsh-cheerful",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		const VERSION = "0.1.0";
		const PKG = "dsh-cheerful";

		/* ------------------------------------------------------------------ *
		 * 触发总线：toolview 与浮层是同一模块里的两个组件，用一个最小订阅表串联。
		 * ------------------------------------------------------------------ */
		const listeners = new Set();
		let fireNonce = 0;

		function normalizeRequest(raw) {
			const source = raw && typeof raw === "object" ? raw : {};
			let side = source.side;
			if (side !== "left" && side !== "right" && side !== "both") side = "both";
			const number = Number(source.intensity);
			const intensity = Number.isFinite(number) ? Math.min(3, Math.max(1, Math.round(number))) : 2;
			fireNonce += 1;
			return { side: side, intensity: intensity, nonce: fireNonce, at: Date.now() };
		}

		function fire(raw) {
			const request = normalizeRequest(raw);
			fireCount += 1;
			for (const listener of Array.from(listeners)) {
				try {
					listener(request);
				} catch (error) {
					console.error("[cheerful] overlay listener failed:", error);
				}
			}
			return request;
		}

		function onFire(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}

		/* ------------------------------------------------------------------ *
		 * 可配置项：所有触发参数集中在这里，默认值可在运行时覆盖。
		 * 覆盖值存 localStorage；window.__dshCheerful.setSettings({...})
		 * 或在「设置 → 通用 → 自动礼花」里改。
		 * ------------------------------------------------------------------ */
		const SETTINGS_KEY = PKG + "/settings";
		/** 旧版本的单一开关键，仅用于迁移。 */
		const AUTO_KEY = PKG + "/auto";

		const DEFAULT_SETTINGS = Object.freeze({
			auto: true,
			minSteps: 2,
			turnIntensity: 2,
			goalIntensity: 3,
			cooldownMs: 1000,
			settleMs: 400,
		});

		function clampNumber(value, min, max, fallback) {
			const number = Number(value);
			if (!Number.isFinite(number)) return fallback;
			return Math.min(max, Math.max(min, Math.round(number)));
		}

		function normalizeSettings(raw) {
			const source = raw && typeof raw === "object" ? raw : {};
			const settings = { ...DEFAULT_SETTINGS };
			if (typeof source.auto === "boolean") settings.auto = source.auto;
			settings.minSteps = clampNumber(source.minSteps, 2, 6, settings.minSteps);
			settings.turnIntensity = clampNumber(source.turnIntensity, 1, 3, settings.turnIntensity);
			settings.goalIntensity = clampNumber(source.goalIntensity, 1, 3, settings.goalIntensity);
			settings.cooldownMs = clampNumber(source.cooldownMs, 0, 60000, settings.cooldownMs);
			settings.settleMs = clampNumber(source.settleMs, 0, 5000, settings.settleMs);
			return settings;
		}

		function readSettings() {
			let stored = null;
			try {
				const raw = window.localStorage.getItem(SETTINGS_KEY);
				stored = raw === null ? null : JSON.parse(raw);
			} catch (error) {
				stored = null;
			}
			const settings = normalizeSettings(stored);
			// 旧版单开关迁移：没有新配置时才看旧键。
			if (stored === null) {
				try {
					const legacy = window.localStorage.getItem(AUTO_KEY);
					if (legacy !== null) settings.auto = legacy === "1";
				} catch (error) {}
			}
			return settings;
		}

		const settingsStore = { value: readSettings(), listeners: new Set() };

		function notifySettings() {
			for (const listener of Array.from(settingsStore.listeners)) {
				try {
					listener(settingsStore.value);
				} catch (error) {
					console.error("[cheerful] settings listener failed:", error);
				}
			}
		}

		function applySettings(patch) {
			const source = patch && typeof patch === "object" ? patch : {};
			const next = normalizeSettings({ ...settingsStore.value, ...source });
			const changed = JSON.stringify(next) !== JSON.stringify(settingsStore.value);
			settingsStore.value = next;
			try {
				window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
				window.localStorage.removeItem(AUTO_KEY);
			} catch (error) {
				// 隐私模式等写不进去时，本次页面内仍然生效。
			}
			if (changed) notifySettings();
			return { ...next };
		}

		function getSettings() {
			return { ...settingsStore.value };
		}

		function setSettings(patch) {
			return applySettings(patch);
		}

		function resetSettings() {
			const next = normalizeSettings({});
			settingsStore.value = next;
			try {
				window.localStorage.removeItem(SETTINGS_KEY);
				window.localStorage.removeItem(AUTO_KEY);
			} catch (error) {}
			notifySettings();
			return { ...next };
		}

		function setAuto(enabled) {
			return applySettings({ auto: enabled === true }).auto;
		}

		function getAuto() {
			return settingsStore.value.auto;
		}

		function useSettings() {
			const [value, setValue] = React.useState(settingsStore.value);
			React.useEffect(() => {
				const listener = (next) => setValue(next);
				settingsStore.listeners.add(listener);
				setValue(settingsStore.value);
				return () => settingsStore.listeners.delete(listener);
			}, []);
			return value;
		}

		const lastAutoFire = new Map();
		let fireCount = 0;

		/** 单轮触发的判定：达到配置的最少步数。 */
		function shouldCelebrateSteps(stepsInTurn, minSteps) {
			const threshold = clampNumber(minSteps, 2, 6, DEFAULT_SETTINGS.minSteps);
			return stepsInTurn >= threshold;
		}

		/** 自动礼花的统一闸门：开关、页面可见性、防抖。 */
		function autoFire(sessionId, intent) {
			const settings = settingsStore.value;
			if (!settings.auto) return false;
			try {
				if (document.visibilityState === "hidden") return false;
			} catch (error) {}
			const now = Date.now();
			const key = typeof sessionId === "string" ? sessionId : "";
			const last = lastAutoFire.get(key) || 0;
			if (now - last < settings.cooldownMs) return false;
			lastAutoFire.set(key, now);
			fire(intent);
			return true;
		}

		/* ------------------------------------------------------------------ *
		 * 工具函数
		 * ------------------------------------------------------------------ */
		const TAU = Math.PI * 2;
		const PALETTE = ["#4D6BFE", "#7C5CFF", "#FFC53D", "#FF7AB6", "#3DDC97", "#5BC0F8", "#FF9F43", "#FFFFFF"];

		function rand(min, max) {
			return min + Math.random() * (max - min);
		}

		function pick(list) {
			return list[Math.floor(Math.random() * list.length)];
		}

		function prefersReducedMotion() {
			try {
				return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			} catch (error) {
				return false;
			}
		}

		/* ------------------------------------------------------------------ *
		 * 礼炮引擎：canvas 粒子 + 两门礼炮的矢量绘制 + 中央文案。
		 * ------------------------------------------------------------------ */
		function createEngine(host) {
			let canvas = null;
			let surface = null;
			let raf = 0;
			let last = 0;
			let width = 0;
			let height = 0;
			let dpr = 1;
			let particles = [];
			let flashes = [];
			let poppers = [];
			let resizeObserver = null;
			let mounted = false;
			let disposed = false;

			function mount() {
				if (mounted || disposed) return;
				mounted = true;
				canvas = document.createElement("canvas");
				canvas.setAttribute("data-dsh-cheerful-canvas", "");
				canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;";
				host.appendChild(canvas);
				surface = canvas.getContext("2d");
				measure();
				if (typeof ResizeObserver === "function") {
					resizeObserver = new ResizeObserver(measure);
					resizeObserver.observe(host);
				} else {
					window.addEventListener("resize", measure);
				}
			}

			function measure() {
				if (!host) return;
				const rect = host.getBoundingClientRect();
				width = Math.max(1, Math.round(rect.width));
				height = Math.max(1, Math.round(rect.height));
				dpr = Math.min(2, window.devicePixelRatio || 1);
				if (!canvas) return;
				canvas.width = Math.round(width * dpr);
				canvas.height = Math.round(height * dpr);
				if (surface) surface.setTransform(dpr, 0, 0, dpr, 0, 0);
			}

			function muzzle(side) {
				return side === "left"
					? { x: width * 0.075, y: height * 0.8 }
					: { x: width * 0.925, y: height * 0.8 };
			}

			function spawn(origin, baseAngle, kind) {
				const angle = baseAngle + rand(-0.42, 0.42);
				const speed = height * (kind === "streamer" ? rand(0.55, 0.9) : rand(0.95, 1.45));
				return {
					kind: kind,
					x: origin.x + Math.cos(angle) * 26,
					y: origin.y + Math.sin(angle) * 26,
					vx: Math.cos(angle) * speed + rand(-60, 60),
					vy: Math.sin(angle) * speed + rand(-40, 40),
					len: kind === "streamer" ? rand(46, 96) : rand(13, 26),
					wid: kind === "streamer" ? rand(3, 5) : rand(4.5, 8.5),
					rot: rand(0, TAU),
					spin: rand(-9, 9),
					phase: rand(0, TAU),
					flutter: rand(3, 9),
					drag: kind === "streamer" ? 1.3 : 0.85,
					gravity: height * (kind === "streamer" ? 0.85 : 1.45),
					color: pick(PALETTE),
					age: 0,
					life: kind === "streamer" ? rand(2.4, 3.4) : rand(2, 3),
					alpha: 1,
				};
			}

			function launch(request) {
				if (disposed) return;
				mount();
				measure();
				if (!surface) return;
				if (prefersReducedMotion()) return;
				const sides = request.side === "both" ? ["left", "right"] : [request.side];
				const count = [26, 44, 64][request.intensity - 1];
				const streamers = [8, 12, 18][request.intensity - 1];
				const now = performance.now();
				for (const side of sides) {
					const origin = muzzle(side);
					const angle = side === "left" ? -Math.PI / 3 : (-Math.PI * 2) / 3;
					poppers.push({ side: side, x: origin.x, y: origin.y, angle: angle, born: now, life: 1500 });
					flashes.push({ x: origin.x + Math.cos(angle) * 26, y: origin.y + Math.sin(angle) * 26, born: now, life: 340 });
					for (let index = 0; index < count; index += 1) particles.push(spawn(origin, angle, "ribbon"));
					for (let index = 0; index < streamers; index += 1) particles.push(spawn(origin, angle, "streamer"));
				}
				start();
			}

			function start() {
				if (raf !== 0 || disposed) return;
				last = 0;
				raf = requestAnimationFrame(frame);
			}

			function frame(now) {
				raf = 0;
				if (disposed || !surface) return;
				const dt = last === 0 ? 0.016 : Math.min(0.05, (now - last) / 1000);
				last = now;
				surface.clearRect(0, 0, width, height);

				for (let index = poppers.length - 1; index >= 0; index -= 1) {
					const popper = poppers[index];
					const progress = (now - popper.born) / popper.life;
					if (progress >= 1) {
						poppers.splice(index, 1);
						continue;
					}
					drawPopper(popper, progress);
				}
				for (let index = flashes.length - 1; index >= 0; index -= 1) {
					const flash = flashes[index];
					const progress = (now - flash.born) / flash.life;
					if (progress >= 1) {
						flashes.splice(index, 1);
						continue;
					}
					drawFlash(flash, progress);
				}

				step(dt);

				for (const particle of particles) drawParticle(particle);

				if (particles.length > 0 || flashes.length > 0 || poppers.length > 0) {
					raf = requestAnimationFrame(frame);
				} else {
					surface.clearRect(0, 0, width, height);
					last = 0;
				}
			}

			function step(dt) {
				for (let index = particles.length - 1; index >= 0; index -= 1) {
					const particle = particles[index];
					particle.age += dt;
					if (particle.age >= particle.life) {
						particles.splice(index, 1);
						continue;
					}
					particle.vy += particle.gravity * dt;
					const damp = Math.exp(-particle.drag * dt);
					particle.vx *= damp;
					particle.vy *= damp;
					particle.x += particle.vx * dt;
					particle.y += particle.vy * dt;
					particle.rot += particle.spin * dt;
					particle.phase += particle.flutter * dt;
					const remaining = particle.life - particle.age;
					particle.alpha = remaining < 0.55 ? Math.max(0, remaining / 0.55) : 1;
				}
			}

			function drawParticle(particle) {
				if (particle.alpha <= 0) return;
				surface.save();
				surface.globalAlpha = particle.alpha;
				surface.translate(particle.x, particle.y);
				surface.rotate(particle.rot);
				surface.strokeStyle = particle.color;
				surface.fillStyle = particle.color;
				if (particle.kind === "streamer") {
					const bend = Math.sin(particle.phase) * particle.len * 0.42;
					surface.beginPath();
					surface.moveTo(-particle.len * 0.5, 0);
					surface.quadraticCurveTo(0, bend, particle.len * 0.5, 0);
					surface.lineWidth = particle.wid;
					surface.lineCap = "round";
					surface.stroke();
				} else {
					surface.beginPath();
					surface.ellipse(0, 0, particle.len * 0.5, particle.wid * 0.5, 0, 0, TAU);
					surface.fill();
					surface.globalAlpha = particle.alpha * 0.55;
					surface.fillStyle = "rgba(255,255,255,0.9)";
					surface.beginPath();
					surface.ellipse(-particle.len * 0.12, -particle.wid * 0.18, particle.len * 0.18, particle.wid * 0.16, 0, 0, TAU);
					surface.fill();
				}
				surface.restore();
			}

			function drawPopper(popper, progress) {
				const age = progress * popper.life;
				const fadeIn = Math.min(1, age / 70);
				const fadeOut = progress > 0.72 ? Math.max(0, 1 - (progress - 0.72) / 0.28) : 1;
				const alpha = Math.min(fadeIn, fadeOut);
				if (alpha <= 0) return;
				const size = Math.max(48, Math.min(88, height * 0.095));
				// 弹入：0 → 1 的 easeOutBack，带一点过冲，像拉炮被拉开。
				const pop = Math.min(1, age / 240);
				const back = 1.70158;
				const overshoot = 1 + (back + 1) * Math.pow(pop - 1, 3) + back * Math.pow(pop - 1, 2);
				const scale = 0.35 + 0.65 * overshoot;
				const recoil = Math.max(0, 1 - age / 160) * 16;
				const facing = popper.side === "left" ? 1 : -1;
				surface.save();
				surface.globalAlpha = alpha;
				surface.translate(
					popper.x - Math.cos(popper.angle) * recoil,
					popper.y - Math.sin(popper.angle) * recoil,
				);
				const glowRadius = size * 0.85;
				const glow = surface.createRadialGradient(0, 0, size * 0.15, 0, 0, glowRadius);
				glow.addColorStop(0, "rgba(255,208,96,0.32)");
				glow.addColorStop(0.55, "rgba(255,122,182,0.16)");
				glow.addColorStop(1, "rgba(255,122,182,0)");
				surface.fillStyle = glow;
				surface.beginPath();
				surface.arc(0, 0, glowRadius, 0, TAU);
				surface.fill();
				// 右侧镜像，让两个 🎉 的炮口都朝向屏幕中间。
				surface.scale(facing * scale, scale);
				surface.font = "600 " + Math.round(size) + "px 'Apple Color Emoji', 'Noto Color Emoji', 'Segoe UI Emoji', 'Twemoji Mozilla', sans-serif";
				surface.textAlign = "center";
				surface.textBaseline = "middle";
				surface.fillText("🎉", 0, 0);
				surface.restore();
			}

			function drawFlash(flash, progress) {
				const radius = 30 + progress * Math.max(width, height) * 0.14;
				const strength = 1 - progress;
				const gradient = surface.createRadialGradient(flash.x, flash.y, 0, flash.x, flash.y, radius);
				gradient.addColorStop(0, "rgba(255,255,255," + (0.95 * strength).toFixed(3) + ")");
				gradient.addColorStop(0.32, "rgba(255,214,102," + (0.62 * strength).toFixed(3) + ")");
				gradient.addColorStop(1, "rgba(255,214,102,0)");
				surface.save();
				surface.globalCompositeOperation = "lighter";
				surface.fillStyle = gradient;
				surface.beginPath();
				surface.arc(flash.x, flash.y, radius, 0, TAU);
				surface.fill();
				surface.restore();
			}

			function destroy() {
				disposed = true;
				if (raf) cancelAnimationFrame(raf);
				raf = 0;
				if (resizeObserver) resizeObserver.disconnect();
				else window.removeEventListener("resize", measure);
				if (canvas) canvas.remove();
				canvas = null;
				surface = null;
				particles = [];
				flashes = [];
				poppers = [];
			}

			return { launch: launch, destroy: destroy, measure: measure };
		}

		/* ------------------------------------------------------------------ *
		 * 浮层组件：shell.overlay 的占位者，整帧 click-through。
		 * ------------------------------------------------------------------ */
		function CheerLayer() {
			const hostRef = React.useRef(null);
			React.useEffect(() => {
				const host = hostRef.current;
				if (!host) return undefined;
				const engine = createEngine(host);
				const unsubscribe = onFire((request) => engine.launch(request));
				return () => {
					unsubscribe();
					engine.destroy();
				};
			}, []);
			return React.createElement("div", {
				"data-dsh-cheerful-layer": "",
				style: {
					position: "absolute",
					inset: "0",
					overflow: "hidden",
					pointerEvents: "none",
					contain: "strict",
				},
			}, React.createElement("div", {
				ref: hostRef,
				style: { position: "absolute", inset: "0", pointerEvents: "none" },
			}));
		}

		/* ------------------------------------------------------------------ *
		 * 工具卡：cheer 调用的行内呈现，同时是触发礼炮的唯一入口。
		 * ------------------------------------------------------------------ */
		function readCallArgs(props) {
			try {
				if (props.phase === "result") {
					const call = props.block ? props.block.call : null;
					if (call && call.args && typeof call.args === "object") return call.args;
					if (call && typeof call.argsRaw === "string" && call.argsRaw !== "") return JSON.parse(call.argsRaw);
					return {};
				}
				const raw = props.block ? props.block.argsRaw : null;
				if (typeof raw === "string" && raw !== "") return JSON.parse(raw);
			} catch (error) {
				return {};
			}
			return {};
		}

		function useCheerTrigger(props, request) {
			const firstRender = React.useRef(true);
			const armed = React.useRef(false);
			const fired = React.useRef(false);
			const phase = props.phase;

			React.useEffect(() => {
				const initial = firstRender.current;
				firstRender.current = false;
				if (initial) {
					// 挂载即 result = 历史回放，绝不重放礼炮；挂载在 start/preparing 才算实时调用。
					armed.current = phase === "start" || phase === "preparing";
					return;
				}
				if (fired.current) return;
				if (phase === "result" && armed.current) {
					fired.current = true;
					fire(request);
					return;
				}
				if (phase === "start") armed.current = true;
			}, [phase]);
		}

		function CheerRow(props) {
			const args = readCallArgs(props);
			const request = React.useMemo(() => ({
				side: args.side,
				intensity: args.intensity,
			}), [args.side, args.intensity]);
			useCheerTrigger(props, request);

			const settled = props.phase === "result";
			const failed = settled && props.block && props.block.isError === true;
			const label = failed ? "礼炮卡壳了" : settled ? "礼炮已发射" : props.phase === "preparing" ? "礼炮准备中…" : "礼炮发射中…";
			const children = [
				React.createElement("span", { key: "icon", style: { fontSize: "16px", lineHeight: 1 } }, failed ? "🧨" : "🎉"),
				React.createElement("span", { key: "label", style: { fontWeight: 600 } }, label),
			];
			children.push(React.createElement("button", {
				key: "again",
				type: "button",
				onClick: () => fire(request),
				style: {
					marginLeft: "auto",
					cursor: "pointer",
					border: "1px solid rgba(128,128,128,0.32)",
					background: "transparent",
					color: "inherit",
					borderRadius: "8px",
					padding: "2px 9px",
					font: "inherit",
					fontSize: "12px",
					opacity: 0.85,
				},
			}, "再放一次"));

			return React.createElement("div", {
				"data-dsh-cheerful-row": "",
				"data-state": failed ? "error" : settled ? "ok" : "running",
				style: {
					display: "flex",
					alignItems: "center",
					gap: "8px",
					padding: "8px 12px",
					border: "1px solid rgba(128,128,128,0.28)",
					borderRadius: "10px",
					background: "rgba(128,128,128,0.06)",
					fontSize: "13px",
					lineHeight: 1.4,
					maxWidth: "560px",
					boxSizing: "border-box",
				},
			}, children);
		}

		/* ------------------------------------------------------------------ *
		 * 自动礼花的隐形观察者：挂进会话页头。
		 * 只在「看到本轮开始 → 本轮结束」时，用 sessionStats 的步数增量判断
		 * 这一轮走了几步，所以刷新页面或回放历史不会误触发。
		 * ------------------------------------------------------------------ */
		function AutoCelebrator(props) {
			const settings = useSettings();
			const auto = settings.auto;
			const settingsRef = React.useRef(settings);
			settingsRef.current = settings;
			const sessionId = props.sessionId;
			const running = props.useSessionStatus((state) =>
				state && typeof state.get === "function" ? (state.get(sessionId) || {}).running === true : false,
			);
			const goalPhase = props.useProjection("goal", (value) => (value && value.goal ? value.goal.phase : undefined));
			const stats = props.useProjection("sessionStats");
			const statsReady = stats !== undefined && stats !== null && typeof stats.steps === "number";
			const steps = statsReady ? stats.steps : 0;
			const stepsRef = React.useRef(steps);
			stepsRef.current = steps;
			const statsReadyRef = React.useRef(statsReady);
			statsReadyRef.current = statsReady;
			const turnStartSteps = React.useRef(steps);
			const turnStartReady = React.useRef(statsReady);
			// 每轮配额：本轮是否已经自动放过；每轮开始时重置。
			const celebratedThisTurn = React.useRef(!running);
			const previousRunning = React.useRef(running);
			const previousGoal = React.useRef(goalPhase);

			React.useEffect(() => {
				const before = previousRunning.current;
				previousRunning.current = running;
				if (!auto || typeof sessionId !== "string") return;
				if (running) {
					if (!before) {
						turnStartSteps.current = stepsRef.current;
						turnStartReady.current = statsReadyRef.current;
						celebratedThisTurn.current = false;
					}
					return;
				}
				if (!before) return;
				const startedReady = turnStartReady.current;
				// 等这一轮最后一批统计落定，再核对步数。
				const timer = setTimeout(() => {
					const current = settingsRef.current;
					if (celebratedThisTurn.current) return;
					if (!startedReady || !statsReadyRef.current) return;
					const stepsInTurn = stepsRef.current - turnStartSteps.current;
					if (!shouldCelebrateSteps(stepsInTurn, current.minSteps)) return;
					if (autoFire(sessionId, { side: "both", intensity: current.turnIntensity })) {
						celebratedThisTurn.current = true;
					}
				}, settingsRef.current.settleMs);
				return () => clearTimeout(timer);
			}, [running, auto, sessionId]);

			React.useEffect(() => {
				const before = previousGoal.current;
				previousGoal.current = goalPhase;
				if (!auto || typeof sessionId !== "string") return;
				if (goalPhase !== "complete" || before === "complete") return;
				if (celebratedThisTurn.current) return;
				if (autoFire(sessionId, { side: "both", intensity: settingsRef.current.goalIntensity })) {
					celebratedThisTurn.current = true;
				}
			}, [goalPhase, auto, sessionId]);

			return null;
		}

		/* ------------------------------------------------------------------ *
		 * 设置 → 通用里的一块：自动礼花开关 + 触发参数。
		 * ------------------------------------------------------------------ */
		const SELECT_STYLE = {
			font: "inherit",
			fontSize: "12px",
			padding: "4px 8px",
			borderRadius: "8px",
			border: "1px solid rgba(128,128,128,0.32)",
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
		};

		function SettingsLine(props) {
			return React.createElement("div", {
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "12px",
					padding: "4px 0",
				},
			}, [
				React.createElement("span", {
					key: "label",
					style: { fontSize: "13px", color: "var(--dsw-alias-label-primary, inherit)" },
				}, props.label),
				React.createElement("span", { key: "control" }, props.children),
			]);
		}

		function NumberSelect(props) {
			return React.createElement("select", {
				value: String(props.value),
				"aria-label": props.label,
				onChange: (event) => props.onChange(Number(event.target.value)),
				style: SELECT_STYLE,
			}, props.values.map((value) => React.createElement("option", {
				key: String(value),
				value: String(value),
			}, String(value))));
		}

		function AutoSwitchRow() {
			const settings = useSettings();
			const update = (patch) => setSettings(patch);
			const head = React.createElement("div", {
				key: "head",
				style: { display: "flex", alignItems: "center", gap: "16px" },
			}, [
				React.createElement("div", { key: "copy", style: { flex: "1", minWidth: 0 } }, [
					React.createElement("div", {
						key: "title",
						style: { fontSize: "13px", fontWeight: 500, color: "var(--dsw-alias-label-primary, inherit)" },
					}, "自动礼花"),
					React.createElement("div", {
						key: "desc",
						style: {
							marginTop: "2px",
							fontSize: "12px",
							lineHeight: 1.5,
							color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))",
						},
					}, "目标完成，或单轮对话走到设定步数时，自动放一次礼炮（每轮最多一次，下一轮重新计数）。"),
				]),
				React.createElement("button", {
					key: "switch",
					type: "button",
					role: "switch",
					"aria-checked": settings.auto ? "true" : "false",
					"aria-label": "自动礼花",
					onClick: () => update({ auto: !settings.auto }),
					style: {
						position: "relative",
						flex: "none",
						width: "42px",
						height: "24px",
						padding: "2px",
						border: "none",
						borderRadius: "999px",
						cursor: "pointer",
						background: settings.auto ? "#4D6BFE" : "rgba(128,128,128,0.35)",
						transition: "background 0.18s ease",
						display: "flex",
						alignItems: "center",
						justifyContent: settings.auto ? "flex-end" : "flex-start",
					},
				}, React.createElement("span", {
					style: {
						display: "block",
						width: "20px",
						height: "20px",
						borderRadius: "999px",
						background: "#FFFFFF",
						boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
						transition: "transform 0.18s ease",
					},
				})),
			]);

			const options = settings.auto
				? React.createElement("div", {
					key: "options",
					style: { marginTop: "6px", paddingLeft: "2px" },
				}, [
					React.createElement(SettingsLine, { key: "minSteps", label: "最少步数" },
						React.createElement(NumberSelect, {
							label: "最少步数",
							value: settings.minSteps,
							values: [2, 3, 4, 5, 6],
							onChange: (value) => update({ minSteps: value }),
						})),
					React.createElement(SettingsLine, { key: "turnIntensity", label: "单轮礼炮强度" },
						React.createElement(NumberSelect, {
							label: "单轮礼炮强度",
							value: settings.turnIntensity,
							values: [1, 2, 3],
							onChange: (value) => update({ turnIntensity: value }),
						})),
					React.createElement(SettingsLine, { key: "goalIntensity", label: "目标完成礼炮强度" },
						React.createElement(NumberSelect, {
							label: "目标完成礼炮强度",
							value: settings.goalIntensity,
							values: [1, 2, 3],
							onChange: (value) => update({ goalIntensity: value }),
						})),
				])
				: null;

			return React.createElement("div", {
				"data-dsh-cheerful-setting": "",
				style: { padding: "12px 0", borderBottom: "1px solid rgba(128,128,128,0.22)" },
			}, [head, options]);
		}

		/* ------------------------------------------------------------------ *
		 * 插件入口
		 * ------------------------------------------------------------------ */
		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: PKG + ".layer", order: 900 }, CheerLayer),
			);
			ctx.slots.inject("tool.call.toolview", () =>
				ctx.slots.register({ name: "tool.call.toolview", key: "cheer" }, CheerRow),
			);
			ctx.slots.inject("settings.general.item", () =>
				ctx.slots.register({ name: "settings.general.item", id: PKG + ".auto", order: 300 }, AutoSwitchRow),
			);
			ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register(
					{ name: "conversation.session.header.actions", id: PKG + ".auto-celebrator", order: 999 },
					AutoCelebrator,
				),
			);
			ctx.effect(() => {
				const onStorage = (event) => {
					if (event.key !== SETTINGS_KEY && event.key !== AUTO_KEY) return;
					const next = readSettings();
					if (JSON.stringify(next) === JSON.stringify(settingsStore.value)) return;
					settingsStore.value = next;
					notifySettings();
				};
				window.addEventListener("storage", onStorage);
				return () => window.removeEventListener("storage", onStorage);
			}, "dsh-cheerful: settings sync");
			try {
				window.__dshCheerful = {
					fire: fire,
					getSettings: getSettings,
					setSettings: setSettings,
					resetSettings: resetSettings,
					setAuto: setAuto,
					getAuto: getAuto,
					getFiredCount: () => fireCount,
					version: VERSION,
					package: PKG,
				};
			} catch (error) {
				// 无法挂调试钩子不影响主功能。
			}
		}

		exports.name = "cheerful";
		exports.inject = ["slots"];
		exports.apply = apply;
		exports.VERSION = VERSION;
		exports.__internals = {
			normalizeRequest: normalizeRequest,
			readCallArgs: readCallArgs,
			createEngine: createEngine,
			CheerLayer: CheerLayer,
			CheerRow: CheerRow,
			AutoCelebrator: AutoCelebrator,
			AutoSwitchRow: AutoSwitchRow,
			setAuto: setAuto,
			getAuto: getAuto,
			getSettings: getSettings,
			setSettings: setSettings,
			resetSettings: resetSettings,
			normalizeSettings: normalizeSettings,
			autoFire: autoFire,
			shouldCelebrateSteps: shouldCelebrateSteps,
			getFiredCount: () => fireCount,
			DEFAULT_SETTINGS: DEFAULT_SETTINGS,
			SETTINGS_KEY: SETTINGS_KEY,
			AUTO_KEY: AUTO_KEY,
		};

		return module.exports;
	},
});