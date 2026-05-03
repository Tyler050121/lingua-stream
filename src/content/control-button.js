(function registerPageControlButton() {
  class PageControlButton {
    constructor({ onPrepare, onToggle, onCancel }) {
      this.onPrepare = onPrepare;
      this.onToggle = onToggle;
      this.onCancel = onCancel;
      this.active = false;
      this.busy = false;
      this.prepared = false;
      this.progress = 0;
      this.phase = "idle";
      this.status = "";
      this.segmentCount = 0;
      this.root = null;
      this.primaryButton = null;
      this.secondaryButton = null;
      this.statusNode = null;
      this.statusTextNode = null;
      this.progressFill = null;
      this.dotNode = null;
      this.prepareToken = 0;
    }

    show() {
      if (this.root) return;

      const host = document.createElement("div");
      host.id = "linguastream-control-host";
      const shadow = host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = `
        :host {
          position: fixed;
          right: 20px;
          bottom: 96px;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        }
        .dock {
          position: relative;
          display: inline-flex;
          align-items: center;
          column-gap: 10px;
          width: 222px;
          max-width: calc(100vw - 40px);
          min-height: 36px;
          overflow: hidden;
          border-radius: 999px;
          padding: 5px 6px 5px 10px;
          box-sizing: border-box;
          color: #18231f;
          border: 1px solid rgba(255, 255, 255, 0.82);
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.78), rgba(246, 250, 248, 0.62));
          box-shadow:
            0 8px 24px rgba(15, 23, 42, 0.13),
            inset 0 1px 0 rgba(255, 255, 255, 0.72);
          backdrop-filter: blur(18px) saturate(1.55);
          -webkit-backdrop-filter: blur(18px) saturate(1.55);
        }
        .dot {
          flex: 0 0 auto;
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: #a4acb8;
          box-shadow: 0 0 0 3px rgba(164, 172, 184, 0.14);
        }
        .dot[data-ready="true"] {
          background: #16815d;
          box-shadow: 0 0 0 3px rgba(22, 129, 93, 0.14);
        }
        .dot[data-active="true"] {
          background: #d66b36;
          box-shadow: 0 0 0 3px rgba(214, 107, 54, 0.16);
        }
        .status {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          color: #3c4944;
          font-size: 12px;
          line-height: 1.2;
          white-space: nowrap;
        }
        .status-text {
          display: inline-block;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          vertical-align: top;
        }
        .actions {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          justify-content: flex-end;
          width: 64px;
          flex: 0 0 auto;
        }
        button {
          width: 30px;
          min-height: 26px;
          border: 0;
          border-radius: 999px;
          padding: 4px;
          color: #26342f;
          background: rgba(255, 255, 255, 0.66);
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0;
          cursor: pointer;
          box-shadow: none;
        }
        button[hidden] {
          display: none;
        }
        button:hover {
          background: rgba(255, 255, 255, 0.9);
        }
        .primary[data-active="true"] {
          color: #ffffff;
          background: #d66b36;
          box-shadow: none;
        }
        .secondary {
          width: 28px;
          color: #64716c;
          background: transparent;
          box-shadow: none;
        }
        .icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          line-height: 1;
        }
        .icon svg {
          width: 15px;
          height: 15px;
          display: block;
          stroke: currentColor;
          stroke-width: 2.25;
          stroke-linecap: round;
          stroke-linejoin: round;
          fill: none;
        }
        .icon[data-kind="spark"] svg {
          width: 14px;
          height: 14px;
          transform: translateX(-1.25px);
        }
        .icon .fill {
          fill: currentColor;
          stroke: none;
        }
        button[disabled] {
          cursor: wait;
          opacity: 0.58;
        }
        .progress {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 2px;
          background: transparent;
        }
        .progress-fill {
          width: 0%;
          height: 100%;
          background: linear-gradient(90deg, #46a381, #d66b36);
          transition: width 160ms ease;
        }
      `;

      const dock = document.createElement("section");
      dock.className = "dock";

      const dot = document.createElement("span");
      dot.className = "dot";

      const status = document.createElement("div");
      status.className = "status";
      const statusText = document.createElement("span");
      statusText.className = "status-text";
      status.append(statusText);

      const actions = document.createElement("div");
      actions.className = "actions";
      const secondary = document.createElement("button");
      secondary.type = "button";
      secondary.className = "secondary";
      secondary.addEventListener("click", () => this.handleSecondaryClick());

      const primary = document.createElement("button");
      primary.type = "button";
      primary.className = "primary";
      primary.addEventListener("click", () => this.handlePrimaryClick());
      actions.append(secondary, primary);

      const progress = document.createElement("div");
      progress.className = "progress";
      const progressFill = document.createElement("div");
      progressFill.className = "progress-fill";
      progress.append(progressFill);

      dock.append(dot, status, actions, progress);
      shadow.append(style, dock);
      document.documentElement.append(host);

      this.root = host;
      this.primaryButton = primary;
      this.secondaryButton = secondary;
      this.statusNode = status;
      this.statusTextNode = statusText;
      this.progressFill = progressFill;
      this.dotNode = dot;
      this.render();
    }

    hide() {
      if (!this.root) return;
      this.root.remove();
      this.root = null;
      this.primaryButton = null;
      this.secondaryButton = null;
      this.statusNode = null;
      this.statusTextNode = null;
      this.progressFill = null;
      this.dotNode = null;
      this.active = false;
      this.busy = false;
      this.prepared = false;
      this.progress = 0;
      this.phase = "idle";
      this.status = "";
      this.segmentCount = 0;
      this.prepareToken += 1;
    }

    async handlePrimaryClick() {
      if (this.busy) return;
      if (!this.prepared) {
        await this.prepare();
        return;
      }
      await this.toggle(!this.active);
    }

    handleSecondaryClick() {
      if (this.busy && !this.prepared) {
        this.cancelPrepare();
        return;
      }
      if (this.prepared && !this.busy) {
        this.prepare({ force: true });
      }
    }

    async prepare(options = {}) {
      if (this.busy) return;
      const token = this.prepareToken + 1;
      this.prepareToken = token;
      this.setBusy(true);
      this.setPrepared(false);
      this.setProgress(0, "preparing");
      this.setStatus("生成中");
      let keepBusy = false;
      try {
        const result = await this.onPrepare({ ...options, requestId: token });
        if (token !== this.prepareToken) return;
        if (result?.inProgress) {
          keepBusy = true;
          this.setProgress(5, "preparing");
          this.setStatus(result.error || "当前视频已经在生成中，请稍等");
          return;
        }
        if (result?.ok === false) throw new Error(result.error || "生成失败");
        this.setPrepared(true, result?.segmentCount || this.segmentCount);
        this.setProgress(100, "ready");
        this.setStatus(result?.cached ? "已缓存" : "声译就绪");
      } catch (error) {
        if (token !== this.prepareToken) return;
        this.setPrepared(false);
        this.setProgress(0, "idle");
        this.setStatus(error.message || String(error));
      } finally {
        if (token === this.prepareToken && !keepBusy) this.setBusy(false);
      }
    }

    cancelPrepare() {
      this.prepareToken += 1;
      if (typeof this.onCancel === "function") this.onCancel();
      this.setBusy(false);
      this.setPrepared(false);
      this.setProgress(0, "idle");
      this.setStatus("已取消");
    }

    async toggle(active) {
      this.setBusy(true);
      this.setStatus(active ? "启动中" : "暂停中");
      try {
        const result = await this.onToggle(active);
        if (result?.ok === false) throw new Error(result.error || "操作失败");
        this.setActive(active);
        this.setStatus(active ? "朗读中" : "已暂停");
      } catch (error) {
        this.setActive(false);
        this.setStatus(error.message || String(error));
      } finally {
        this.setBusy(false);
      }
    }

    setActive(active) {
      this.active = Boolean(active);
      this.render();
    }

    setBusy(busy) {
      this.busy = Boolean(busy);
      this.render();
    }

    setPrepared(prepared, segmentCount = this.segmentCount) {
      this.prepared = Boolean(prepared);
      this.segmentCount = Number(segmentCount) || 0;
      if (!this.prepared) this.active = false;
      this.render();
    }

    setProgress(progress, phase = this.phase) {
      this.progress = Math.max(0, Math.min(100, Number(progress) || 0));
      this.phase = phase || "idle";
      this.render();
    }

    setStatus(status) {
      this.status = String(status || "");
      this.render();
    }

    render() {
      if (!this.primaryButton) return;
      this.primaryButton.dataset.active = String(this.active);
      this.primaryButton.disabled = this.busy;
      this.primaryButton.hidden = this.busy;
      this.secondaryButton.disabled = false;
      this.secondaryButton.hidden = !this.prepared && !this.busy;
      this.secondaryButton.title = this.busy && !this.prepared ? "取消" : "重新生成";
      this.secondaryButton.setAttribute("aria-label", this.secondaryButton.title);
      this.secondaryButton.innerHTML = this.busy && !this.prepared
        ? icon("cancel")
        : icon("retry");
      this.primaryButton.title = this.prepared
        ? (this.active ? "暂停声译" : "播放声译")
        : "启用声译";
      this.primaryButton.setAttribute("aria-label", this.primaryButton.title);
      this.primaryButton.innerHTML = this.prepared
          ? (this.active
            ? icon("pause")
            : icon("play"))
          : icon("spark");

      if (this.statusNode && this.statusTextNode) {
        const text = this.status || "LinguaStream";
        this.statusTextNode.textContent = text;
      }
      if (this.progressFill) {
        this.progressFill.style.width = `${this.progress}%`;
      }
      if (this.dotNode) {
        this.dotNode.dataset.ready = String(this.prepared);
        this.dotNode.dataset.active = String(this.active);
      }
    }
  }

  function icon(name) {
    const icons = {
      spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/></svg>',
      loading: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="fill" cx="7" cy="12" r="1.6"/><circle class="fill" cx="12" cy="12" r="1.6"/><circle class="fill" cx="17" cy="12" r="1.6"/></svg>',
      play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M8 5.5v13l10-6.5-10-6.5z"/></svg>',
      pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg>',
      retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 5v5h-5"/></svg>',
      cancel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
    };
    return `<span class="icon" data-kind="${name}" aria-hidden="true">${icons[name] || ""}</span>`;
  }

  window.LinguaStream.PageControlButton = PageControlButton;
})();
