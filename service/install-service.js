const { Service } = require('node-windows');
const path = require('path');
const args = process.argv.slice(2);
const cmd = args[0] || '';

const svc = new Service({
  name: 'VantaBot',
  description: 'Vanta moderation bot service',
  script: path.join(__dirname, '..', 'index.js'),
  nodeOptions: ['--harmony', '--max_old_space_size=256'],
});

if (cmd === 'install') {
  svc.on('install', () => {
    console.log('Service installed');
    svc.start();
  });
  svc.on('alreadyinstalled', () => console.log('Service already installed'));
  svc.on('invalidinstallation', () => console.log('Invalid installation'));
  svc.on('error', (err) => console.error('Service install error', err));
  svc.install();
} else if (cmd === 'uninstall') {
  svc.on('uninstall', () => console.log('Service uninstalled'));
  svc.on('error', (err) => console.error('Service uninstall error', err));
  svc.uninstall();
} else {
  console.log('Usage: node install-service.js install|uninstall');
}
