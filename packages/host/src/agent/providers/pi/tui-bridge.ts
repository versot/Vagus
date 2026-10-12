

export const TUI_WIDGET_MARKER = "\u001eVAGUS_TUI_WIDGET_V1";

export const TUI_CUSTOM_MARKER = "\u001eVAGUS_TUI_CUSTOM_V1:";

export const TUI_INPUT_TITLE = "\u001eVAGUS_TUI_INPUT_V1";

export const PI_TUI_WIDGET_BRIDGE_SOURCE = String.raw`const MARKER = "\u001eVAGUS_TUI_WIDGET_V1";
const CUSTOM_MARKER = "\u001eVAGUS_TUI_CUSTOM_V1:";
const INPUT_TITLE = "\u001eVAGUS_TUI_INPUT_V1";
const WIDTH = 100;
const DEFAULT_KEYS = {
  "tui.select.up": ["\u001b[A", "k"], "tui.select.down": ["\u001b[B", "j"],
  "tui.select.pageUp": ["\u001b[5~"], "tui.select.pageDown": ["\u001b[6~"],
  "tui.select.confirm": ["\r"], "tui.select.cancel": ["\u001b"],
  "tui.input.submit": ["\r"], "tui.input.newLine": ["\u001b[13;5u"], "tui.input.tab": ["\t"],
};
const keybindings = {
  matches(data, binding) { return (DEFAULT_KEYS[binding] ?? []).includes(data); },
  getKeys(binding) { return [...(DEFAULT_KEYS[binding] ?? [])]; },
  getDefinition(binding) { return { defaultKeys: [...(DEFAULT_KEYS[binding] ?? [])], description: binding }; },
  getConflicts() { return []; }, setUserBindings() {}, getUserBindings() { return {}; }, getResolvedBindings() { return {}; },
};

export default function vagusTuiWidgetBridge(pi) {
  let patchedUi;
  const patchContext = (context) => {
    if (!patchedUi || !context?.ui || context.ui === patchedUi) return;
    try {
      context.ui.setWidget = patchedUi.setWidget;
      context.ui.custom = patchedUi.custom;
    } catch {}
  };
  const patchArgs = (args) => {
    for (const value of args) {
      if (value && typeof value === "object" && value.ui) {
        patchContext(value);
        return;
      }
    }
  };
  const originalOn = pi.on.bind(pi);
  pi.on = (event, handler) => originalOn(event, (...args) => {
    patchContext(args[1]);
    return handler(...args);
  });
  const originalRegisterCommand = pi.registerCommand.bind(pi);
  pi.registerCommand = (name, command) => originalRegisterCommand(name, {
    ...command,
    handler: async (...args) => {
      patchContext(args[1]);
      return command.handler(...args);
    },
  });
  const originalRegisterTool = pi.registerTool.bind(pi);
  pi.registerTool = (tool) => originalRegisterTool({
    ...tool,
    execute: async (...args) => {
      patchArgs(args);
      return tool.execute(...args);
    },
  });
  originalOn("session_start", (_event, ctx) => {
    const ui = ctx.ui;
    const setWidget = ui.setWidget.bind(ui);
    const active = new Map();
    const createTui = (requestRender) => {
      const terminal = new Proxy({ columns: WIDTH, rows: 28, width: WIDTH, height: 28 }, {
        get(target, key) { return key in target ? target[key] : undefined; },
        set(target, key, value) { if (key in target && typeof value === "number") target[key] = value; return true; },
      });
      const inputListeners = new Set();
      return new Proxy({
        mode: "regular", terminal, fullRedraws: 0,
        requestRender, renderNow: requestRender, start: () => {}, stop: () => {},
        addChild: () => {}, removeChild: () => {}, clear: () => {}, setFocus: () => {},
        getShowHardwareCursor: () => false, setShowHardwareCursor: () => {},
        getClearOnShrink: () => false, setClearOnShrink: () => {},
        addInputListener: (listener) => { inputListeners.add(listener); return () => inputListeners.delete(listener); },
        removeInputListener: (listener) => inputListeners.delete(listener),
        onTerminalColorSchemeChange: () => () => {}, setTerminalColorSchemeNotifications: () => {},
        queryTerminalColors: async () => ({}), showOverlay: () => ({ hide() {}, setHidden() {}, isHidden() { return true; }, focus() {}, unfocus() {}, isFocused() { return false; } }),
        hideOverlay: () => {}, hasOverlay: () => false,
        dispatchInput: (data) => {
          let current = data;
          for (const listener of inputListeners) {
            const result = listener(current);
            if (result?.data !== undefined) current = result.data;
            if (result?.consume) return;
          }
          return current;
        },
      }, { get(target, key) { return key in target ? target[key] : () => {}; } });
    };

    const clear = (key) => {
      const previous = active.get(key);
      if (previous?.timer) clearTimeout(previous.timer);
      if (previous) {
        previous.closed = true;
        previous.controller?.abort();
        previous.resolve?.(undefined);
      }
      try { previous?.component?.dispose?.(); } catch {}
      active.delete(key);
    };
    const publish = (key, component, placement, custom = false) => {
      try {
        const width = active.get(key)?.tui?.terminal?.columns ?? WIDTH;
        const rendered = component.render(width);
        const lines = Array.isArray(rendered) ? rendered.filter((line) => typeof line === "string") : [];
        setWidget(key, [MARKER, ...(custom ? [CUSTOM_MARKER + JSON.stringify({ title: "自定义界面" })] : []), ...lines], { placement });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setWidget(key, [MARKER, ...(custom ? [CUSTOM_MARKER + JSON.stringify({ title: "自定义界面" })] : []), "组件渲染失败：" + message], { placement });
      }
    };
    const dispatchCustomInput = (state, message) => {
      let event;
      try { event = JSON.parse(message); } catch { return; }
      if (event?.type === "resize") {
        const columns = Math.max(24, Math.min(240, Math.floor(event.columns)));
        const rows = Math.max(4, Math.min(100, Math.floor(event.rows)));
        state.tui.terminal.columns = columns;
        state.tui.terminal.width = columns;
        state.tui.terminal.rows = rows;
        state.tui.terminal.height = rows;
        state.tui.requestRender();
      } else if (event?.type === "key" && typeof event.data === "string" && event.data.length <= 128) {
        const data = state.tui.dispatchInput(event.data);
        if (typeof data === "string") state.component?.handleInput?.(data);
        state.tui.requestRender();
      } else if (event?.type === "mouse" && state.component?.handleMouse) {
        state.component.handleMouse(event.event);
        state.tui.requestRender();
      }
    };
    const startInputPump = (key, state) => {
      const pump = async () => {
        while (!state.closed && active.get(key) === state) {
          let input;
          try { input = await ui.input(INPUT_TITLE, key, { signal: state.controller.signal }); }
          catch { break; }
          if (state.closed || active.get(key) !== state) break;
          if (typeof input === "string") dispatchCustomInput(state, input);
        }
      };
      void pump();
    };
    ui.setWidget = (key, content, options) => {
      const placement = options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor";
      clear(key);
      if (typeof content !== "function") {
        setWidget(key, content, options);
        return;
      }
      try {
        let state;
        const tui = createTui(() => {
          if (!state || !active.has(key) || state.timer) return;
          state.timer = setTimeout(() => { state.timer = undefined; if (active.get(key) === state) publish(key, state.component, placement); }, 32);
        });
        const component = content(tui, ui.theme);
        state = { component, timer: undefined, tui, closed: false };
        active.set(key, state);
        publish(key, component, placement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setWidget(key, [MARKER, "组件初始化失败：" + message], { placement });
      }
    };
    ui.custom = (factory, options = {}) => new Promise((resolve) => {
      const key = "vagus-custom-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const controller = new AbortController();
      let state;
      const tui = createTui(() => {
        if (!state || state.closed || state.timer) return;
        state.timer = setTimeout(() => {
          state.timer = undefined;
          if (active.get(key) === state) publish(key, state.component, "aboveEditor", true);
        }, 32);
      });
      const done = (value) => {
        if (!state || state.closed) return;
        state.closed = true;
        controller.abort();
        if (state.timer) clearTimeout(state.timer);
        try { state.component?.dispose?.(); } catch {}
        if (active.get(key) === state) active.delete(key);
        setWidget(key, undefined, { placement: "aboveEditor" });
        resolve(value);
      };
      state = { component: undefined, timer: undefined, tui, closed: false, controller, resolve };
      active.set(key, state);
      Promise.resolve().then(() => factory(tui, ui.theme, keybindings, done)).then((component) => {
        if (state.closed) { try { component?.dispose?.(); } catch {} return; }
        if (!component || typeof component.render !== "function") { done(undefined); return; }
        state.component = component;
        publish(key, component, "aboveEditor", true);
        startInputPump(key, state);
      }).catch((error) => {
        if (state.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        setWidget(key, [MARKER, CUSTOM_MARKER + JSON.stringify({ title: "自定义界面" }), "组件初始化失败：" + message], { placement: "aboveEditor" });
        done(undefined);
      });
      void options;
    });
    patchedUi = ui;
    pi.on("session_shutdown", () => { for (const key of active.keys()) clear(key); });
  });
}
`;
