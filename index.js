/*
 * OS.js - JavaScript Cloud/Web Desktop Platform
 *
 * Copyright (c) Anders Evenrud <andersevenrud@gmail.com>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * @author  Anders Evenrud <andersevenrud@gmail.com>
 * @licence Simplified BSD License
 */

import {h, app} from 'hyperapp';
import {Box, TextField, Toolbar, Button} from '@osjs/gui';
import {name as applicationName} from './metadata.json';
import RFB from '@novnc/novnc/core/rfb.js';
import osjs from 'osjs';

RFB.prototype._screenSize = function() {
  return {
    w: this._target.innerWidth,
    h: this._target.innerHeight
  };
};

//
// VNC Window Factory
//
const vncWindow = (core, proc) => {
  const mainTitle = core.make('osjs/locale').translatableFlat(proc.metadata.title);
  const playSound = name => core.has('osjs/sounds') ? core.make('osjs/sounds').play(name) : null;
  const createNotification = (message) => core.make('osjs/notification', {
    icon: proc.resource('logo.png'),
    title: mainTitle,
    message
  });

  return (url, options = {}) => proc.createWindow({
    icon: proc.resource('logo.png'),
    title: `${mainTitle} - Connecting to ${url}`,
    dimension: {width: 800, height: 600}
  }).render(($content, win) => {
    const sendKey = (ev, down) => rfb.sendKey(0, ev.code, down);
    const setTitle = append => win.setTitle(`${mainTitle} - ${append}`);
    const rfb = new RFB($content, url, Object.assign({
      shared: true
    }, options));

    // Listen for events on the VNC client
    rfb.addEventListener('securityfailure', ev => createNotification(`Security handshake failure (${ev.detail.tatus}): ${ev.detail.reason}`));
    rfb.addEventListener('bell', () => playSound('bell'));
    rfb.addEventListener('desktopname', ev => setTitle(ev.detail.name));
    rfb.addEventListener('clipboard', ev => core.make('osjs/clipboard').set(ev.detail.text));

    rfb.addEventListener('disconnect', () => {
      createNotification(`Disconnected from ${url}`);
      win.destroy();
    });

    rfb.addEventListener('connect', () => {
      createNotification(`Connected to ${url}`);
      win.emit('resize');
    });

    rfb.addEventListener('capabilities', ev => {
      proc.emit('vnc:update-session', url, win, ev.detail.capabilities);
      console.warn(ev.detail.capabilities);
    });

    rfb.addEventListener('credentialsrequired', ev => console.error(ev.detail.types));

    // Forward OS.js events
    win.on('focus', () => rfb.focus());
    win.on('blur', () => rfb.blur());
    win.on('keydown', ev => sendKey(ev, true));
    win.on('keyup', ev => sendKey(ev, false));
    win.on('resize', () => rfb._windowResize());

    // Bind VNC library methods as events
    win.on('vnc:cad', () => rfb.sendCtrlAltDel());
    win.on('vnc:shutdown', () => rfb.machineShutdown());
    win.on('vnc:paste', text => rfb.clipboardPasteFrom(text));
    win.on('vnc:reboot', () => rfb.machineReboot());
    win.on('vnc:reset', () => rfb.machineReset());
    win.on('vnc:disconnect', () => rfb.disconnect());

    // Bind some internal events
    win.on('destroy', () => proc.emit('vnc:destroy-session', url, win));
    win.on('render', () => proc.emit('vnc:create-session', url, win, options));

    win.emit('resize');
  });
};

//
// Connection Window Factory
//
const connectionWindow = (core, proc, callback) => () => {
  const mainTitle = core.make('osjs/locale').translatableFlat(proc.metadata.title);

  const view = (state, actions) => h(Box, {}, [
    h(Box, {grow: 1, padding: 0}, [
      h(TextField, {placeholder: 'URL', type: 'text', value: state.url, oninput: (ev, url) => actions.setState({url})}),
      h(TextField, {placeholder: 'Username', type: 'text', value: state.username, oninput: (ev, username) => actions.setState({username})}),
      h(TextField, {placeholder: 'Password', type: 'password', value: state.password, oninput: (ev, password) => actions.setState({password})})
    ]),
    h(Toolbar, {}, [
      h(Button, {onclick: () => actions.connect()}, 'Connect'),
      h(Button, {onclick: () => actions.close()}, 'Close')
    ])
  ]);

  return proc.createWindow({
    icon: proc.resource('logo.png'),
    title: mainTitle,
    dimension: {width: 400, height: 300},
    position: 'center',
    attributes: {sessionable: false}
  }).render(($content, win) => {
    app({
      url: 'ws://10.0.0.74:6080',
      username: '',
      password: 'abc123'
    }, {
      setState: append => () => append,
      close: () => () => win.close(),
      connect: () => (state, actions) => {
        actions.close();

        callback(state.url, {
          credentials: {
            username: state.username,
            password: state.password
          }
        });
      }
    }, view, $content);
  });
};

//
// OS.js Application
//
const register = (core, args, options, metadata) => {
  const sessions = {};
  const proc = core.make('osjs/application', {args, options, metadata});
  const createVncWindow = vncWindow(core, proc);

  const createConnectionWindow = connectionWindow(core, proc, (url, options) => {
    createVncWindow(url, options);
  });

  const updateApplicationSession = () => proc.args.sessions = Object.keys(sessions)
    .reduce((result, url) => Object.assign({[url]: sessions[url].options}, result), {});

  const getSessionMenu = () => Object.keys(sessions).map(url => {
    const {win, capabilities} = sessions[url];

    const items = [{
      label: 'Send Ctrl+Alt+Del',
      disabled: !capabilities.power,
      onclick: () => win.emit('vnc:cad')
    }, {
      label: 'Send shutdown signal',
      disabled: !capabilities.power,
      onclick: () => win.emit('vnc:shutdown')
    }, {
      label: 'Send reboot signal',
      disabled: !capabilities.power,
      onclick: () => win.emit('vnc:reboot')
    }, {
      label: 'Send reset signal',
      disabled: !capabilities.power,
      onclick: () => win.emit('vnc:reset')
    }];

    return {
      label: url,
      items: [{
        label: 'Disconnect',
        onclick: () => win.emit('vnc:disconnect')
      }, ...items]
    };
  });

  const tray = core.make('osjs/tray', {
    icon: proc.resource('logo.png'),
    onclick: ev => core.make('osjs/contextmenu', {
      position: ev,
      menu: [{
        label: 'Create VNC connection',
        onclick: () => createConnectionWindow()
      }, {
        label: 'Sessions',
        disabled: Object.keys(sessions).length <= 0,
        items: getSessionMenu()
      }, {
        label: 'Quit',
        onclick: () => proc.destroy()
      }]
    })
  });

  proc.on('destroy', () => tray.destroy());

  proc.on('vnc:create-session', (url, win, options) => {
    sessions[url] = {win, options, capabilities: {}};
    updateApplicationSession();
  });

  proc.on('vnc:destroy-session', (url, win) => {
    delete sessions[url];
    updateApplicationSession();
  });

  proc.on('vnc:update-session', (url, win, capabilities) => {
    sessions[url].capabilities = capabilities;
  });

  if (args.sessions) {
    Object.keys(args.sessions)
      .forEach(url => createVncWindow(url, args.sessions[url]));
  } else {
    createConnectionWindow();
  }

  return proc;
};

//
// Register OS.js Application
//
osjs.register(applicationName, register);
