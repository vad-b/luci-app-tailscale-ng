/* SPDX-License-Identifier: GPL-3.0-only
 *
 * Copyright (C) 2024 asvow
 * Copyright (C) 2026 vad-b
 */

'use strict';
'require form';
'require fs';
'require network';
'require poll';
'require rpc';
'require uci';
'require ui';
'require view';

// RPC

const callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: ['name'],
	expect: { '': {} }
});

const callInitAction = rpc.declare({
	object: 'luci',
	method: 'setInitAction',
	params: ['name', 'action'],
	expect: { result: false }
});

// Helpers

// Cached service list result to avoid duplicate calls
let cachedServiceList = null;
let latestTsInfo = null;

const APP_VERSION = '@APP_VERSION@';

function isNewerAppVersion(candidate, current) {
	const pattern = /^v?(\d+)\.(\d+)\.(\d+)$/;
	const candidateParts = pattern.exec(candidate);
	const currentParts = pattern.exec(current);
	if (!candidateParts || !currentParts)
		return false;

	for (let i = 1; i <= 3; i++) {
		const next = Number(candidateParts[i]);
		const previous = Number(currentParts[i]);
		if (next !== previous)
			return next > previous;
	}
	return false;
}

async function getAvailableAppUpdate() {
	const controller = new AbortController();
	const timeout = setTimeout(function() { controller.abort(); }, 10000);
	try {
		const response = await fetch('https://api.github.com/repos/vad-b/luci-app-tailscale-ng/releases/latest', {
			'credentials': 'omit',
			'referrerPolicy': 'no-referrer',
			'signal': controller.signal
		});
		if (!response.ok)
			throw new Error('GitHub HTTP ' + response.status);
		const release = await response.json();
		if (release.draft || release.prerelease || !isNewerAppVersion(release.tag_name, APP_VERSION))
			return null;
		return {
			version: release.tag_name.replace(/^v/, ''),
			url: 'https://github.com/vad-b/luci-app-tailscale-ng/releases/tag/' + encodeURIComponent(release.tag_name)
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function getServiceStatus() {
	try {
		cachedServiceList = await callServiceList('tailscale');
		return cachedServiceList?.tailscale?.instances?.instance1?.running || false;
	} catch (e) {
		return false;
	}
}

async function getInterfaceSubnets() {
	try {
		await uci.load('network');
		const subnets = [];

		uci.sections('network', 'interface', function(section) {
			const name = section['.name'];
			if (name === 'lan' || name === 'wan') {
				const ipaddr = section.ipaddr;
				const netmask = section.netmask || '255.255.255.0';
				if (ipaddr && !ipaddr.includes(':')) {
					const maskParts = netmask.split('.').map(Number);
					const cidr = maskParts.reduce((acc, part) => acc + (part.toString(2).match(/1/g) || []).length, 0);
					const ipParts = ipaddr.split('.').map(Number);
					const subnetParts = ipParts.map((part, i) => part & maskParts[i]);
					subnets.push(subnetParts.join('.') + '/' + cidr);
				}
			}
		});

		return [...new Set(subnets)];
	} catch (e) {
		return [];
	}
}

async function getTailscaleInfo(isRunning) {
	const info = {
		isRunning: isRunning,
		backendState: undefined,
		authURL: undefined,
		displayName: undefined,
		onlineExitNodes: [],
		subnetRoutes: []
	};

	try {
		if (!isRunning)
			return info;

		const tailscaleRes = await fs.exec('/usr/sbin/tailscale', ['status', '--json']);

		if (tailscaleRes.code === 0 && tailscaleRes.stdout) {
			const status = JSON.parse(tailscaleRes.stdout.replace(/("\w+"):\s*(\d+)/g, '$1:"$2"'));

			info.backendState = status.BackendState;
			info.authURL = status.AuthURL;

			if (info.backendState === 'Running' && status.Self && status.User) {
				info.displayName = status.User[status.Self.UserID]?.DisplayName;
			}

			if (!status.AuthURL && status.BackendState === 'NeedsLogin') {
				fs.exec('/usr/sbin/tailscale', ['login'])
					.catch(function() {});
			}

			if (status.Peer) {
				info.onlineExitNodes = Object.values(status.Peer)
					.filter(peer => peer.ExitNodeOption && peer.Online)
					.map(peer => peer.DNSName ? peer.DNSName : peer.HostName);
				info.subnetRoutes = Object.values(status.Peer)
					.flatMap(peer => peer.PrimaryRoutes || []);
			}
		}
	} catch (e) {}
	return info;
}

async function getStatusData() {
	const data = {
		tailscaleStatus: null,
		tailscaleIp: null,
		tailscaleInterface: null,
		tailscaleNetcheck: null,
		tailscaleDnsStatus: null
	};

	function getCommandOutput(res) {
		if (!res) return null;
		if (res.stdout && res.stdout.trim()) return res.stdout;
		if (res.stderr && res.stderr.trim()) return res.stderr;
		if (typeof res.code === 'number' && res.code !== 0) {
			return _('Command exited with code ') + String(res.code);
		}
		return null;
	}

	try {
		const [statusRes, ipRes, ifconfigRes, netcheckRes, dnsStatusRes] = await Promise.all([
			fs.exec('/usr/sbin/tailscale', ['status']),
			fs.exec('/usr/sbin/tailscale', ['ip']),
			fs.exec('/sbin/ip', ['addr', 'show', 'tailscale0']),
			fs.exec('/usr/sbin/tailscale', ['netcheck']),
			fs.exec('/usr/sbin/tailscale', ['dns', 'status'])
		]);

		data.tailscaleStatus = getCommandOutput(statusRes);
		data.tailscaleIp = getCommandOutput(ipRes);
		data.tailscaleInterface = getCommandOutput(ifconfigRes);
		data.tailscaleNetcheck = getCommandOutput(netcheckRes);
		data.tailscaleDnsStatus = getCommandOutput(dnsStatusRes);
	} catch (e) {
		data.tailscaleStatus = _('Error: unable to load status data.');
	}

	return data;
}

async function handleServiceAction(action, message) {
	ui.showModal(null, [E('p', { 'class': 'spinning' }, message)]);
	await callInitAction('luci-app-tailscale-ng', action);
	location.reload();
}

function handleLogoutAndClean() {
	if (!confirm(_('Are you sure you want to log out and clean the local state?')))
		return Promise.resolve();

	ui.showModal(null, [E('p', { 'class': 'spinning' }, _('Logging out and cleaning state...'))]);
	return fs.exec('/usr/sbin/tailscale', ['logout']).then(function() {
		ui.hideModal();
		location.reload();
	}).catch(function(e) {
		ui.hideModal();
		ui.addNotification(null, E('p', {}, _('Error: ') + e.message), 'error');
	});
}

function updateLogoutSection(info) {
	const show = !!(info && info.backendState === 'Running');
	const title = document.getElementById('ts-logout-title');
	const row = document.getElementById('ts-logout-row');

	if (title)
		title.style.display = show ? '' : 'none';
	if (row)
		row.style.display = show ? '' : 'none';
}

function updateExitNodeOptions(info) {
	const select = document.querySelector('select[name$=".exit_node"], select[id$=".exit_node"]');
	if (!select)
		return;

	const prevValue = select.value;
	const nodes = Array.isArray(info?.onlineExitNodes) ? info.onlineExitNodes : [];

	while (select.options.length > 0)
		select.remove(0);

	select.add(new Option(_('-- None --'), ''));
	nodes.forEach(function(node) {
		select.add(new Option(node, node));
	});

	if (Array.from(select.options).some(function(opt) { return opt.value === prevValue; }))
		select.value = prevValue;
	else
		select.value = '';
}

// Icons

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs, children) {
	const el = document.createElementNS(SVG_NS, tag);
	Object.entries(attrs || {}).forEach(([key, value]) => el.setAttribute(key, value));
	(children || []).forEach(child => el.appendChild(child));
	return el;
}

function createIcon(children) {
	return svgEl('svg', {
		xmlns: SVG_NS,
		width: '16',
		height: '16',
		viewBox: '0 0 24 24',
		fill: 'none',
		stroke: 'currentColor',
		'stroke-width': '2',
		'stroke-linecap': 'round',
		'stroke-linejoin': 'round'
	}, children);
}

const icons = {
	restart: () => createIcon([
		svgEl('path', { d: 'M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }),
		svgEl('path', { d: 'M21 3v5h-5' })
	]),
	stop: () => createIcon([
		svgEl('circle', { cx: '12', cy: '12', r: '10' }),
		svgEl('rect', { x: '9', y: '9', width: '6', height: '6', rx: '1' })
	]),
	start: () => createIcon([
		svgEl('circle', { cx: '12', cy: '12', r: '10' }),
		svgEl('polygon', { points: '10,8 16,12 10,16' })
	]),
	enable: () => createIcon([
		svgEl('polygon', { points: '6,3 20,12 6,21' })
	]),
	disable: () => createIcon([
		svgEl('rect', { x: '14', y: '4', width: '4', height: '16', rx: '1' }),
		svgEl('rect', { x: '6', y: '4', width: '4', height: '16', rx: '1' })
	])
};

function renderIconButton(icon, text, className, onClick) {
	return E('button', {
		'class': 'btn ' + className,
		'click': onClick,
		'style': 'display: inline-flex; align-items: center;'
	}, [
		E('span', { 'style': 'display: inline-flex; align-items: center; margin-right: 5px;' }, [icon]),
		E('span', {}, text)
	]);
}

function renderServiceStatusContent(isRunning, info) {
	if (!isRunning)
		return E('span', { 'style': 'font-weight: bold; color: #c00;' }, _('Not running'));

	const nodes = [
		E('span', { 'style': 'font-weight: bold; color: #080;' }, _('Running'))
	];

	if (info && info.backendState) {
		nodes.push(E('span', {}, ', '));
		if (info.backendState === 'Running') {
			nodes.push(E('span', { 'style': 'font-weight: bold; color: #080;' }, _('Logged in')));
		} else if (info.backendState === 'NeedsLogin') {
			nodes.push(E('span', { 'style': 'font-weight: bold; color: #c00;' }, _('Logged out')));
		} else {
			nodes.push(E('span', { 'style': 'font-weight: bold; color: #c50;' }, _('Checking login...')));
		}
	}

	return E('span', {}, nodes);
}

// Custom form options

const ServiceStatusValue = form.DummyValue.extend({
	__name__: 'ServiceStatusValue',
	isRunning: false,
	tsInfo: null,

	renderWidget: function() {
		const isRunning = this.isRunning;
		const info = this.tsInfo || null;

		const statusSpan = E('div', {
			'id': 'ts-service-status',
			'style': 'display: inline-block; min-width: 170px; margin-right: 10px;'
		}, [renderServiceStatusContent(isRunning, info)]);

		const buttonsDiv = E('div', {
			'id': 'ts-service-controls',
			'style': 'display: inline-flex; gap: 5px;'
		});

		if (isRunning) {
			buttonsDiv.appendChild(renderIconButton(
				icons.restart(), _('Restart'), 'cbi-button-action',
				ui.createHandlerFn(this, function() {
					return handleServiceAction('restart', _('Restarting Tailscale service...'));
				})
			));
			buttonsDiv.appendChild(renderIconButton(
				icons.stop(), _('Stop'), 'cbi-button-negative',
				ui.createHandlerFn(this, function() {
					return handleServiceAction('stop', _('Stopping Tailscale service...'));
				})
			));
		} else {
			buttonsDiv.appendChild(renderIconButton(
				icons.start(), _('Start'), 'cbi-button-positive',
				ui.createHandlerFn(this, function() {
					return handleServiceAction('start', _('Starting Tailscale service...'));
				})
			));
		}

		return E('div', { 'style': 'display: flex; align-items: center;' }, [statusSpan, buttonsDiv]);
	}
});

const LoginStatusValue = form.DummyValue.extend({
	__name__: 'LoginStatusValue',
	tsInfo: null,

	renderWidget: function() {
		const info = this.tsInfo || {};
		return E('div', { 'id': 'ts-login-status', 'style': 'line-height: 30px;' },
			renderLoginStatusContent(info));
	}
});

function renderLoginStatusContent(info) {
	if (info.backendState === 'NeedsLogin' && info.authURL) {
		return E('a', {
			'href': info.authURL,
			'target': '_blank',
			'class': 'btn cbi-button-negative',
			'style': 'font-weight: 700;'
		}, _('Click here to log in'));
	} else if (info.backendState === 'Running' && info.displayName) {
		return E('span', {}, [
			E('strong', {}, info.displayName),
			' - ',
			E('a', {
				'href': 'https://login.tailscale.com/admin/machines',
				'target': '_blank'
			}, _('Manage in Admin Console'))
		]);
	} else if (!info.isRunning) {
		return E('span', { 'style': 'color: #c50;' }, _('Service not running'));
	} else {
		return E('em', { 'class': 'spinning' }, _('Checking status...'));
	}
}

// Status section (full-width with title and pre block)
const StatusOutputValue = form.DummyValue.extend({
	__name__: 'StatusOutputValue',
	statusId: '',
	command: '',
	content: '',
	sectionTitle: '',

	render: function(option_index, section_id, in_table) {
		const isLoading = this.content === null;
		const hasContent = this.content && this.content.trim();

		let preContent;
		if (isLoading) {
			// Show loading spinner
			preContent = E('em', { 'class': 'spinning' }, _('Loading...'));
		} else if (hasContent) {
			preContent = this.content;
		} else {
			preContent = _('No output available. Service may not be running.');
		}

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', { 'class': 'cbi-section-title' }, [
				this.sectionTitle,
				E('span', {
					'style': 'font-size: 0.75em; font-weight: normal; color: #666; margin-left: 0.5em;'
				}, '(' + this.command + ')')
			]),
			E('pre', {
				'id': this.statusId,
				'style': 'background: #f9f9f9; padding: 10px; border: 1px solid #ddd; overflow-x: auto; white-space: pre; font-family: monospace; font-size: 13px;'
			}, preContent)
		]);
	}
});

// Section title (full-width header)
const SectionTitle = form.DummyValue.extend({
	__name__: 'SectionTitle',
	title: '',

	render: function(option_index, section_id, in_table) {
		return E('h3', { 'class': 'cbi-section-title' }, this.title);
	}
});

const DynamicLogoutTitle = SectionTitle.extend({
	__name__: 'DynamicLogoutTitle',
	tsInfo: null,

	render: function(option_index, section_id, in_table) {
		const self = this;
		const out = SectionTitle.prototype.render.apply(this, arguments);
		const applyVisibility = function(node) {
			if (!node)
				return node;
			node.id = 'ts-logout-title';
			if (!self.tsInfo || self.tsInfo.backendState !== 'Running')
				node.style.display = 'none';
			return node;
		};

		if (out && typeof out.then === 'function')
			return out.then(applyVisibility);

		return applyVisibility(out);
	}
});

const DynamicLogoutButton = form.Button.extend({
	__name__: 'DynamicLogoutButton',
	tsInfo: null,

	render: function(option_index, section_id, in_table) {
		const self = this;
		const out = form.Button.prototype.render.apply(this, arguments);
		const applyVisibility = function(node) {
			if (!node)
				return node;
			node.id = 'ts-logout-row';
			if (!self.tsInfo || self.tsInfo.backendState !== 'Running')
				node.style.display = 'none';
			return node;
		};

		if (out && typeof out.then === 'function')
			return out.then(applyVisibility);

		return applyVisibility(out);
	}
});

function showAppUpdate(update) {
	const installCommand = 'wget -qO- https://raw.githubusercontent.com/vad-b/luci-app-tailscale-ng/main/install.sh | sh';
	const commandBlock = E('pre', {
		'style': 'white-space:pre-wrap;overflow-wrap:anywhere;box-sizing:border-box;margin:0;padding:12px 48px 12px 12px'
	}, [installCommand]);
	const copyIcon = createIcon([
		svgEl('rect', { 'x': '9', 'y': '9', 'width': '13', 'height': '13', 'rx': '2' }),
		svgEl('path', { 'd': 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' })
	]);
	copyIcon.setAttribute('aria-hidden', 'true');
	const copyButton = E('button', {
		'type': 'button',
		'class': 'btn',
		'title': _('Copy command'),
		'aria-label': _('Copy command'),
		'style': 'position:absolute;top:6px;right:6px;width:28px;height:28px;padding:4px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center',
		'click': async function(ev) {
			const button = ev.currentTarget;
			let copied = false;
			try {
				await navigator.clipboard.writeText(installCommand);
				copied = true;
			} catch (e) {}
			if (!copied) {
				const selection = window.getSelection();
				const range = document.createRange();
				range.selectNodeContents(commandBlock);
				selection.removeAllRanges();
				selection.addRange(range);
				try {
					copied = document.execCommand('copy');
				} catch (e) {}
			}
			button.textContent = copied ? '✓' : '!';
			button.setAttribute('title', copied ? _('Copied') : _('Copy manually'));
			button.setAttribute('aria-label', copied ? _('Copied') : _('Copy manually'));
		}
	}, [copyIcon]);
	const modal = ui.showModal(_('Update available'), [
		E('p', {}, [_('Current version'), ': ', E('strong', {}, ['v' + APP_VERSION])]),
		E('p', {}, [
			_('New version'), ': ', E('strong', {}, ['v' + update.version]), ' · ',
			E('a', {
				'href': update.url,
				'target': '_blank',
				'rel': 'noopener'
			}, [_('Release notes'), ' ↗'])
		]),
		E('p', {}, [_('To update, run this command as root in an SSH session on your router:')]),
		E('div', { 'style': 'position:relative;margin-bottom:1em' }, [commandBlock, copyButton]),
		E('div', { 'class': 'right' }, [
			E('button', {
				'type': 'button',
				'class': 'btn',
				'click': ui.hideModal
			}, _('Close'))
		])
	]);
	modal.style.maxWidth = '560px';
}

// Main view

return view.extend({
	load: function() {
		return getServiceStatus().then(function(isRunning) {
			return Promise.all([
				Promise.resolve(isRunning),
				getTailscaleInfo(isRunning),
				getInterfaceSubnets(),
				fs.exec('/usr/sbin/tailscale', ['version'])
			]);
		});
	},

	render: function(data) {
		const isRunning = data[0];
		const tsInfo = data[1];
		latestTsInfo = tsInfo;
		const interfaceSubnets = data[2];
		const versionRes = data[3];
		const tsVersion = (versionRes && versionRes.code === 0 && versionRes.stdout)
			? versionRes.stdout.trim().split('\n')[0]
			: null;

		let m, s, o;

		// Config map (luci-app-tailscale-ng + chained tailscale)
		m = new form.Map('luci-app-tailscale-ng', _('Tailscale NG'),
			_('Tailscale is a cross-platform and easy to use virtual LAN.'));

		// Chain original tailscale config so o.uciconfig='tailscale' options load/save correctly.
		m.chain('tailscale');

		// Service
		s = m.section(form.NamedSection, 'settings', 'settings');
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Tailscale Enabled'));
		o.description = _('Start Tailscale service on boot.');
		o.default = '0';
		o.rmempty = false;

		o = s.option(ServiceStatusValue, '_service_status', _('Tailscale Status'));
		o.isRunning = isRunning;
		o.tsInfo = tsInfo;

		o = s.option(form.DummyValue, '_tailscale_version', _('Tailscale Version'));
		o.renderWidget = function() {
			return E('div', { 'style': 'line-height: 30px;' }, tsVersion || _('N/A'));
		};

		// Tabs
		s = m.section(form.NamedSection, 'settings', 'settings');
		s.anonymous = true;
		s.addremove = false;

		s.tab('auth', _('Authentication'));
		s.tab('settings', _('Settings'));
		s.tab('status', _('Status'));

		// Authentication tab
		o = s.taboption('auth', SectionTitle, '_auth_title');
		o.title = _('Authentication');

		o = s.taboption('auth', LoginStatusValue, '_login_status', _('Login Status'));
		o.tsInfo = tsInfo;

		o = s.taboption('auth', form.Value, 'login_server', _('Login Server'));
		o.description = _('Base URL of login (control) server.');
		o.placeholder = 'https://controlplane.tailscale.com';
		o.rmempty = true;

		o = s.taboption('auth', form.Value, 'authkey', _('Pre-authentication Key'));
		o.description = _('Set the machine authorization key.') + '<br />' +
			'<em>' + _('Use a non-reusable auth key and disable key expiry for trusted machines via the provider admin console.') + '</em>';
		o.placeholder = 'tskey-auth-...';
		o.rmempty = true;

		// Logout (dynamic visibility)
		o = s.taboption('auth', DynamicLogoutTitle, '_logout_title');
		o.title = _('Logout and Clean');
		o.tsInfo = tsInfo;

		o = s.taboption('auth', DynamicLogoutButton, '_logout', _('Logout'));
		o.inputtitle = _('Logout and Clean');
		o.inputstyle = 'negative';
		o.description = _('Disconnect from login server, expire current login, and flush local state cache.');
		o.tsInfo = tsInfo;
		o.onclick = function() {
			return handleLogoutAndClean();
		};

		// Settings tab: General
		o = s.taboption('settings', SectionTitle, '_general_title');
		o.title = _('General');

		o = s.taboption('settings', form.Value, 'port', _('Listen Port'));
		o.uciconfig = 'tailscale';
		o.description = _('UDP port to listen on for WireGuard and peer-to-peer traffic.');
		o.datatype = 'port';
		o.default = '41641';
		o.rmempty = false;

		o = s.taboption('settings', form.Value, 'state_file', _('State File'));
		o.uciconfig = 'tailscale';
		o.description = _('Path to state file. WARNING: Changing this requires reauthentication.');
		o.default = '/etc/tailscale/tailscaled.state';
		o.rmempty = false;

		o = s.taboption('settings', form.ListValue, 'fw_mode', _('Firewall Mode'));
		o.uciconfig = 'tailscale';
		o.description = _('Select the firewall backend to use.');
		o.value('nftables', 'nftables');
		o.value('iptables', 'iptables');
		o.default = 'nftables';
		o.rmempty = false;

		// Settings tab: DNS
		o = s.taboption('settings', SectionTitle, '_dns_title');
		o.title = _('DNS');

		o = s.taboption('settings', form.Flag, 'accept_dns', _('Accept DNS'));
		o.description = _('Accept DNS configuration from the control server.');
		o.default = '1';
		o.rmempty = false;

		// Settings tab: Routing
		o = s.taboption('settings', SectionTitle, '_routing_title');
		o.title = _('Routing');

		o = s.taboption('settings', form.Flag, 'advertise_exit_node', _('Advertise Exit Node'));
		o.description = _('Offer to be an exit node for outbound internet traffic.');
		o.default = '0';
		o.rmempty = false;

		o = s.taboption('settings', form.Flag, 'accept_routes', _('Accept Subnet Routes'));
		o.description = _('Accept subnet routes that other nodes advertise.');
		o.default = '0';
		o.rmempty = false;

		o = s.taboption('settings', form.DynamicList, 'advertise_routes', _('Advertised Routes'));
		o.description = _('Subnets to advertise to other Tailscale nodes, e.g. <code>192.168.1.0/24</code>.');
		if (interfaceSubnets.length > 0) {
			interfaceSubnets.forEach(function(subnet) {
				o.value(subnet, subnet);
			});
		}
		o.datatype = 'cidr4';
		o.rmempty = true;

		o = s.taboption('settings', form.ListValue, 'exit_node', _('Exit Node'));
		o.description = _('Select an online machine to use as an exit node.');
		o.value('', _('-- None --'));
		if (tsInfo.onlineExitNodes.length > 0) {
			tsInfo.onlineExitNodes.forEach(function(node) {
				o.value(node, node);
			});
		}
		o.default = '';
		o.depends('advertise_exit_node', '0');
		o.rmempty = true;

		// Settings tab: Logging
		o = s.taboption('settings', SectionTitle, '_logging_title');
		o.title = _('Logging');

		o = s.taboption('settings', form.Flag, 'log_stdout', _('StdOut Logging'));
		o.uciconfig = 'tailscale';
		o.description = _('Logging program activities.');
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('settings', form.Flag, 'log_stderr', _('StdErr Logging'));
		o.uciconfig = 'tailscale';
		o.description = _('Logging program errors and exceptions.');
		o.default = '1';
		o.rmempty = false;

		// Settings tab: Extra
		o = s.taboption('settings', SectionTitle, '_extra_title');
		o.title = _('Extra');

		o = s.taboption('settings', form.DynamicList, 'flags', _('Additional Flags'));
		o.description = String.format(
			_('Extra flags in format --flag=value. See %s for available options.'),
			'<a href="https://tailscale.com/kb/1241/tailscale-up" target="_blank">' + _('Tailscale documentation') + '</a>'
		);
		o.rmempty = true;

		// Status tab (lazy loaded)
		o = s.taboption('status', StatusOutputValue, '_status_main');
		o.sectionTitle = _('Tailscale Status');
		o.statusId = 'tailscale_status';
		o.command = '/usr/sbin/tailscale status';
		o.content = null; // Will be loaded lazily

		o = s.taboption('status', StatusOutputValue, '_status_ip');
		o.sectionTitle = _('Tailscale IP');
		o.statusId = 'tailscale_ip';
		o.command = '/usr/sbin/tailscale ip';
		o.content = null;

		o = s.taboption('status', StatusOutputValue, '_status_interface');
		o.sectionTitle = _('Tailscale Interface');
		o.statusId = 'tailscale_interface';
		o.command = '/sbin/ip addr show tailscale0';
		o.content = null;

		o = s.taboption('status', StatusOutputValue, '_status_netcheck');
		o.sectionTitle = _('Tailscale Netcheck');
		o.statusId = 'tailscale_netcheck';
		o.command = '/usr/sbin/tailscale netcheck';
		o.content = null;

		o = s.taboption('status', StatusOutputValue, '_status_dns');
		o.sectionTitle = _('Tailscale DNS Status');
		o.statusId = 'tailscale_dns_status';
		o.command = '/usr/sbin/tailscale dns status';
		o.content = null;

		// Status tab: lazy loading + polling
		let statusDataLoaded = false;

		async function loadStatusData() {
			if (statusDataLoaded) return;

			const newData = await getStatusData();
			const sections = [
				{ id: 'tailscale_status', data: newData.tailscaleStatus },
				{ id: 'tailscale_ip', data: newData.tailscaleIp },
				{ id: 'tailscale_interface', data: newData.tailscaleInterface },
				{ id: 'tailscale_netcheck', data: newData.tailscaleNetcheck },
				{ id: 'tailscale_dns_status', data: newData.tailscaleDnsStatus }
			];

			sections.forEach(function(section) {
				const pre = document.getElementById(section.id);
				if (pre) {
					while (pre.firstChild) pre.removeChild(pre.firstChild);
					pre.textContent = section.data && section.data.trim()
						? section.data
						: _('No output available. Service may not be running.');
				}
			});

			statusDataLoaded = true;
		}

		// Poll service status and login status
		poll.add(async function() {
			const running = await getServiceStatus();
			const info = await getTailscaleInfo(running);
			latestTsInfo = info;

			// Update service status display
			const statusEl = document.getElementById('ts-service-status');
			if (statusEl) {
				while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
				statusEl.appendChild(renderServiceStatusContent(running, info));
			}

			// Update login status
			const loginEl = document.getElementById('ts-login-status');
			if (loginEl) {
				while (loginEl.firstChild) loginEl.removeChild(loginEl.firstChild);
				loginEl.appendChild(renderLoginStatusContent(info));
			}

			updateExitNodeOptions(info);
			updateLogoutSection(info);

			// If status tab is active (has class cbi-tab, not cbi-tab-disabled), refresh its data
			const statusTabActive = document.querySelector('li.cbi-tab[data-tab="status"]');
			if (statusTabActive) {
				statusDataLoaded = false; // Force refresh
				loadStatusData();
			}
		}, 15);

		return m.render().then(function(mapNode) {
			const heading = mapNode.querySelector('h2');
			if (heading) {
				const githubIcon = svgEl('svg', {
					'width': '14',
					'height': '14',
					'viewBox': '0 0 16 16',
					'fill': 'currentColor',
					'aria-hidden': 'true',
					'style': 'vertical-align:-0.125em;margin-right:0.3em'
				}, [svgEl('path', {
					'd': 'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656'
				})]);
				const metadata = E('span', {
					'style': 'display:inline-block;margin-left:16px;font-size:13px;font-weight:400;line-height:18px;white-space:nowrap'
				}, [
					'v' + APP_VERSION + ' · ',
					E('a', {
						'href': 'https://github.com/vad-b/luci-app-tailscale-ng',
						'target': '_blank',
						'rel': 'noopener'
					}, [githubIcon, 'GitHub'])
				]);
				heading.appendChild(metadata);
				getAvailableAppUpdate().then(function(update) {
					if (!update)
						return;
					metadata.appendChild(document.createTextNode(' · '));
					metadata.appendChild(E('button', {
						'type': 'button',
						'style': 'display:inline-block;padding:1px 7px;border:1px solid #fcd34d;border-radius:4px;background:#fef3c7;color:#713f12;font-family:inherit;font-size:12px;font-weight:400;line-height:18px;vertical-align:baseline;cursor:pointer',
						'click': function() { showAppUpdate(update); }
					}, [_('Update available: %s').format('v' + update.version)]));
				}).catch(function(error) {
					console.warn('Unable to check for application updates:', error);
				});
			}

			// Start loading status data immediately in background (fire and forget)
			loadStatusData();
			updateExitNodeOptions(tsInfo);
			updateLogoutSection(tsInfo);

			// If login status shows "Checking status...", update it more aggressively
			// This handles the case when service just started
			if (tsInfo.backendState !== 'Running' && isRunning) {
				const quickUpdateLogin = async function() {
					const info = await getTailscaleInfo(true);
					latestTsInfo = info;

					// Keep service status block in sync with quick login updates.
					const statusEl = document.getElementById('ts-service-status');
					if (statusEl) {
						while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
						statusEl.appendChild(renderServiceStatusContent(true, info));
					}

					// Keep login status block in sync with quick login updates.
					const loginEl = document.getElementById('ts-login-status');
					if (loginEl) {
						while (loginEl.firstChild) loginEl.removeChild(loginEl.firstChild);
						loginEl.appendChild(renderLoginStatusContent(info));
					}

					updateExitNodeOptions(info);
					updateLogoutSection(info);

					// When login completes, force-refresh full Status tab data once.
					if (info.backendState === 'Running') {
						statusDataLoaded = false;
						loadStatusData();
						return;
					}

					// Stop aggressive polling once auth URL is available for user action.
					if (info.backendState === 'NeedsLogin' && info.authURL) {
						return;
					}

					// Still not ready, try again in 2 seconds.
					setTimeout(quickUpdateLogin, 2000);
				};
				setTimeout(quickUpdateLogin, 2000);
			}

			// Add click listener for Status tab to trigger load if not yet loaded
			const statusTabLink = mapNode.querySelector('.cbi-tabmenu li:last-child a, .cbi-tabmenu li[data-tab="status"] a');
			if (statusTabLink) {
				statusTabLink.addEventListener('click', function() {
					setTimeout(loadStatusData, 100); // Will return immediately if already loaded
				});
			}

			// Also try via tab container click
			mapNode.addEventListener('click', function(ev) {
				const tabItem = ev.target.closest('.cbi-tabmenu li');
				if (tabItem && tabItem.textContent.includes('Status')) {
					setTimeout(loadStatusData, 100);
				}
				if (tabItem && tabItem.textContent.includes('Settings')) {
					setTimeout(function() {
						updateExitNodeOptions(latestTsInfo || tsInfo);
					}, 100);
				}
			});

			return mapNode;
		});
	}
});
