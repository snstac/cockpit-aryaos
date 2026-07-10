# cockpit-aryaos — site-wide TAK administration for AryaOS, in the browser

The [Cockpit](https://cockpit-project.org/) **"AryaOS Site"** plugin for
[AryaOS](https://github.com/snstac/aryaos): one page for everything the whole sensor
fleet inherits. Set the **site COT_URL**, choose the ADS-B decoder, and **upload
site-wide TAK TLS certificates once** (`PYTAK_TLS_CLIENT_CERT/KEY/CAFILE` in
`/etc/aryaos/aryaos-config.txt`, inherited by every PyTAK gateway) — then restart the
sensor fleet with one click. The page also shows nearby AryaOS nodes heard over Mesh SA,
including roles, health, position status, and admin links. Per-tool tweaks live in each
gateway's own Cockpit plugin.

## Install

Pre-installed on AryaOS; from the [snstac package repository](https://snstac.github.io/packages):

```sh
sudo apt install cockpit-aryaos
```

## The snstac TAK sensor ecosystem

Different sensor, same workflow — pick the gateway for your application; most have a
matching Cockpit plugin for browser-based management:

| Application | Gateway | Cockpit plugin |
|---|---|---|
| Aircraft via ADS-B (1090 MHz / 978 MHz UAT) | [adsbcot](https://github.com/snstac/adsbcot) | [cockpit-adsbcot](https://github.com/snstac/cockpit-adsbcot) |
| Ships & vessels via AIS | [aiscot](https://github.com/snstac/aiscot) | [cockpit-aiscot](https://github.com/snstac/cockpit-aiscot), [cockpit-aiscatcher](https://github.com/snstac/cockpit-aiscatcher) |
| Drone / UAS Remote ID (counter-UAS) | [dronecot](https://github.com/snstac/dronecot) | [cockpit-dronecot](https://github.com/snstac/cockpit-dronecot) |
| Own position via GPS/GNSS | [lincot](https://github.com/snstac/lincot) | [cockpit-lincot](https://github.com/snstac/cockpit-lincot), [cockpit-gps](https://github.com/snstac/cockpit-gps) |
| APRS amateur radio | [aprscot](https://github.com/snstac/aprscot) | — |
| Weather stations | [windtak](https://github.com/snstac/windtak) | — |
| CoT routing / TAK Server bridging | [charontak](https://github.com/snstac/charontak) | — |

All gateways are built on [PyTAK](https://github.com/snstac/pytak), speak
**Cursor on Target (CoT)** to **ATAK, WinTAK, iTAK, TAK Server, and Mesh SA**, ship as
signed Debian/RPM packages at [snstac.github.io/packages](https://snstac.github.io/packages),
and come pre-installed on [AryaOS](https://github.com/snstac/aryaos), the
situational-awareness OS for Raspberry Pi.
