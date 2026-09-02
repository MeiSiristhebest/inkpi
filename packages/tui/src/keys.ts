/**
 * 终端按键与事件模型与解析器
 * 支持常规按键、控制组合键、鼠标滚轮/点击、焦点通知与剪贴板 Bracketed Paste
 */

export interface KeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
  raw: Buffer | string;
  isMouse?: boolean;
  mouseX?: number;
  mouseY?: number;
}

export function parseKey(input: Buffer | string): KeyEvent {
  const str = typeof input === 'string' ? input : input.toString('utf8');

  const event: KeyEvent = {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    sequence: str,
    raw: input
  };

  // 1. Mouse SGR extended sequences (\x1b[<button;x;yM or m)
  const mouseMatch = str.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (mouseMatch) {
    const btn = parseInt(mouseMatch[1], 10);
    const x = parseInt(mouseMatch[2], 10);
    const y = parseInt(mouseMatch[3], 10);
    event.isMouse = true;
    event.mouseX = x;
    event.mouseY = y;

    if (btn === 64) {
      event.name = 'wheelup';
    } else if (btn === 65) {
      event.name = 'wheeldown';
    } else {
      event.name = `mouse_${btn}`;
    }
    return event;
  }

  // 2. Focus In / Out events
  if (str === '\x1b[I') {
    event.name = 'focusin';
    return event;
  }
  if (str === '\x1b[O') {
    event.name = 'focusout';
    return event;
  }

  // 3. Bracketed Paste mode sequences
  if (str === '\x1b[200~') {
    event.name = 'paste_start';
    return event;
  }
  if (str === '\x1b[201~') {
    event.name = 'paste_end';
    return event;
  }

  // 4. Special escape sequences
  if (str === '\r' || str === '\n') {
    event.name = 'enter';
  } else if (str === '\t') {
    event.name = 'tab';
  } else if (str === '\x1b[Z') {
    event.name = 'tab';
    event.shift = true;
  } else if (str === '\x7f' || str === '\x08') {
    event.name = 'backspace';
  } else if (str === '\x1b') {
    event.name = 'escape';
  } else if (str === ' ') {
    event.name = 'space';
  } else if (str === '\x1b[A' || str === '\x1bOA') {
    event.name = 'up';
  } else if (str === '\x1b[B' || str === '\x1bOB') {
    event.name = 'down';
  } else if (str === '\x1b[C' || str === '\x1bOC') {
    event.name = 'right';
  } else if (str === '\x1b[D' || str === '\x1bOD') {
    event.name = 'left';
  } else if (str === '\x1b[1;5A') {
    event.name = 'up';
    event.ctrl = true;
  } else if (str === '\x1b[1;5B') {
    event.name = 'down';
    event.ctrl = true;
  } else if (str === '\x1b[1;5C') {
    event.name = 'right';
    event.ctrl = true;
  } else if (str === '\x1b[1;5D') {
    event.name = 'left';
    event.ctrl = true;
  } else if (str === '\x1b[H' || str === '\x1b[1~') {
    event.name = 'home';
  } else if (str === '\x1b[F' || str === '\x1b[4~') {
    event.name = 'end';
  } else if (str === '\x1b[5~') {
    event.name = 'pageup';
  } else if (str === '\x1b[6~') {
    event.name = 'pagedown';
  } else if (str === '\x1b[3~') {
    event.name = 'delete';
  } else if (str === '\x1bOP') {
    event.name = 'f1';
  } else if (str === '\x1bOQ') {
    event.name = 'f2';
  } else if (str === '\x1bOR') {
    event.name = 'f3';
  } else if (str === '\x1bOS') {
    event.name = 'f4';
  } else if (str.length === 1 && str.charCodeAt(0) >= 1 && str.charCodeAt(0) <= 26) {
    // Control characters Ctrl+A -> 1, Ctrl+Z -> 26
    event.ctrl = true;
    event.name = String.fromCharCode(str.charCodeAt(0) + 96);
  } else if (str.startsWith('\x1b') && str.length === 2) {
    event.meta = true;
    event.name = str[1].toLowerCase();
  } else {
    event.name = str;
  }

  return event;
}
