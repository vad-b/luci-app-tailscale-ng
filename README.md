# luci-app-tailscale-ng

LuCI web interface for managing [Tailscale](https://tailscale.com/) on OpenWRT routers.

Inspired by [asvow/luci-app-tailscale](https://github.com/asvow/luci-app-tailscale), this project is a ground-up redesign that eliminates conflicts with the standard OpenWRT `tailscale` package.

## Screenshots

<table style="width: 100%; table-layout: fixed;">
  <tr>
    <td align="center" valign="top" width="33.33%"><strong>Authentication</strong></td>
    <td align="center" valign="top" width="33.33%"><strong>Settings</strong></td>
    <td align="center" valign="top" width="33.33%"><strong>Status</strong></td>
  </tr>
  <tr>
    <td valign="top" width="33.33%"><img src="docs/images/tailscale-ng-auth.png" alt="Tailscale NG Authentication tab" width="100%"></td>
    <td valign="top" width="33.33%"><img src="docs/images/tailscale-ng-settings.png" alt="Tailscale NG Settings tab" width="100%"></td>
    <td valign="top" width="33.33%"><img src="docs/images/tailscale-ng-status.png" alt="Tailscale NG Status tab" width="100%"></td>
  </tr>
</table>

## Motivation

The goals of `luci-app-tailscale-ng` are:

- keep integration non-conflicting with the standard OpenWRT `tailscale` package
- make the OpenWRT Tailscale UI closer to the Tailscale management UI in pfSense and OPNsense

The original [asvow/luci-app-tailscale](https://github.com/asvow/luci-app-tailscale) project is excellent and inspired this work, but its integration model is tightly coupled to core files from the OpenWRT `tailscale` package, which leads to two operational drawbacks:

- **Invasive Installation** - installation overwrites original `/etc/init.d/tailscale` and `/etc/config/tailscale` files.
- **Breaking Uninstallation** - uninstall removes these required files; restoring normal Tailscale operation requires manual file recreation or reinstalling the `tailscale` package.

See [asvow/luci-app-tailscale#31](https://github.com/asvow/luci-app-tailscale/issues/31) for details.

## How it works

**luci-app-tailscale-ng** takes a non-invasive approach:

- **Does not replace** any files from the `tailscale` package - the original `/etc/init.d/tailscale` and `/etc/config/tailscale` remain untouched
- **Adds its own** UCI config (`/etc/config/luci-app-tailscale-ng`) and init script (`/etc/init.d/luci-app-tailscale-ng`) that work alongside the standard ones
- **Manages `tailscale up` parameters** by reading settings from its own config and applying them via the `tailscale` CLI
- **Combines two configs** in the UI - settings from the standard `tailscale` config (port, state file, firewall mode, logging) and our extended config (auth, DNS, routing, exit nodes) are presented on a single page

This means you can install and remove the package at any time without breaking your Tailscale setup.

## Features

- Enable/disable Tailscale service with auto-start on boot
- Configure listen port, state file path, firewall mode
- Login status with one-click authentication link
- Configure control server URL and pre-authentication keys
- Accept DNS / Accept subnet routes
- Advertise as exit node or select a remote exit node (with auto-detection of exit nodes)
- Advertise local subnets (with auto-detection of LAN/WAN networks)
- Pass additional `tailscale up` flags
- Live status dashboard (tailscale status, IP, interface, netcheck, DNS)
- Automatic settings reapply on network interface changes via hotplug

## Current limitations

This package focuses on managing `tailscale up` command-line parameters. It does **not** automatically create network interfaces or firewall rules for Tailscale traffic - you may need to configure these manually if your setup requires it.

## Roadmap

- Auto-create network interfaces and firewall zones/rules for Tailscale
- Import existing Tailscale settings on first install (read current running parameters and populate the config)
- Backup and restore of the Tailscale state file
- Update Tailscale directly from the web UI (both standard and size-optimized builds for memory-constrained devices)

## Installation

### Quick install (auto-detects `opkg` / `apk`)

```shell
wget -qO- https://raw.githubusercontent.com/vad-b/luci-app-tailscale-ng/main/install.sh | sh
```

### Manual install (`opkg` / `.ipk`)

Download the latest `.ipk` package from [Releases](https://github.com/vad-b/luci-app-tailscale-ng/releases), upload it to the router's `/tmp` directory, then:

```shell
opkg install /tmp/luci-app-tailscale-ng_*.ipk
```

### Manual install (`apk` / `.apk`)

Download the latest `.apk` package from [Releases](https://github.com/vad-b/luci-app-tailscale-ng/releases), upload it to the router's `/tmp` directory, then:

```shell
apk add --allow-untrusted --upgrade /tmp/luci-app-tailscale-ng_*.apk
```

After installation, navigate to **VPN -> Tailscale NG** in the LuCI web interface.

## Credits

- [asvow/luci-app-tailscale](https://github.com/asvow/luci-app-tailscale) - the project that inspired this work

## License

[GPL-3.0](LICENSE)
