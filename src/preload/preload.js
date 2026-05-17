'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  windowControl: (action) => ipcRenderer.send('window:control', action),
  onWindowState: (callback) => {
    const handler = (_e, isMax) => callback(isMax);
    ipcRenderer.on('window:state', handler);
    return () => ipcRenderer.removeListener('window:state', handler);
  },

  getHistory: () => ipcRenderer.invoke('history:list'),
  addHistory: (entry) => ipcRenderer.invoke('history:add', entry),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  listEnvironments: () => ipcRenderer.invoke('env:list'),
  saveEnvironment: (env) => ipcRenderer.invoke('env:save', env),
  deleteEnvironment: (id) => ipcRenderer.invoke('env:delete', id),
  setLastEnvironment: (id) => ipcRenderer.invoke('env:setLast', id),

  parseKey: (text) => ipcRenderer.invoke('key:parse', text),
  pickKey: () => ipcRenderer.invoke('dialog:pickKey'),
  pickPublicKey: () => ipcRenderer.invoke('dialog:pickPublicKey'),

  connect: (conn) => ipcRenderer.invoke('proxmox:connect', conn),
  diagnose: (conn) => ipcRenderer.invoke('proxmox:diagnose', conn),
  resolveAddresses: (payload) =>
    ipcRenderer.invoke('proxmox:resolveAddresses', payload),
  onAddressProgress: (callback) => {
    const handler = (_e, msg) => callback(msg);
    ipcRenderer.on('address:progress', handler);
    return () => ipcRenderer.removeListener('address:progress', handler);
  },
  deploy: (payload) => ipcRenderer.invoke('deploy:start', payload),
  verify: (payload) => ipcRenderer.invoke('verify:start', payload),
  onVerifyProgress: (callback) => {
    const handler = (_e, msg) => callback(msg);
    ipcRenderer.on('verify:progress', handler);
    return () => ipcRenderer.removeListener('verify:progress', handler);
  },

  onDeployProgress: (callback) => {
    const handler = (_e, msg) => callback(msg);
    ipcRenderer.on('deploy:progress', handler);
    return () => ipcRenderer.removeListener('deploy:progress', handler);
  },
});
