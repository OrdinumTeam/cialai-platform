// SPDX-License-Identifier: Apache-2.0
// Package pathmgr chooses and keeps the path from the phone to one paired
// desktop. The proxy dials the desktop edge through Manager.DialContext and
// the gomobile layer drives Connect and the network and foreground
// notifications; neither needs to know which transport carries a stream.
//
// # Steps
//
// An evaluation runs the steps of the connectivity plan in order, each with its
// own budget measured on the injected Clock:
//
//	step                 budget  candidates
//	1. local network     1.5 s   lan candidates of the reach card and those reported by native discovery
//	2. direct internet   4 s     ipv6, mapped and stun candidates of the reach card
//	3. Tor fallback      20 s    onion address of the reach card, bootstrap included
//	4. NAT punch         5 s     fresh candidates exchanged over the fallback channel
//
// Steps 1 and 2 run in parallel, so together they take at most 4 s, enough for
// the QUIC handshake over a slow mobile network. A local session wins over an
// internet one: when the internet dial answers first the manager waits for
// the local dial, which ends within its own 1.5 s budget.
// The candidates of an expired card are not dialed; reported local candidates
// always are. Step 3 polls the Tor bootstrap and reports its progress through
// Config.OnTor, then dials the onion with the pinned desktop key, retrying
// within the budget. The fallback becomes the active path as soon as it
// answers, and step 4 then runs in the background when the stability rules
// allow it.
//
// # Stability
//
//   - The active path is replaced at once when it fails: the direct session
//     ends, a stream or onion dial fails with a network error, a network change
//     is not survived by migration, or the proxy calls ReportFailure after
//     three lost bridge pings. A failed local path moves to steps 2 and 3, a
//     failed internet or punched path to step 3, and a failed fallback runs
//     every step again.
//   - Improving a working fallback is limited: no attempt to move from Tor to a
//     direct path within Timings.Hysteresis (2 min) of the last switch or loss
//     of a path, and at most one attempt every Timings.UpgradeInterval (5 min).
//     An attempt runs steps 1, 2 and 4. The first evaluation of a manager
//     punches right after the fallback connects, since no switch happened yet.
//   - A network change with a direct path active first migrates the QUIC
//     session to a new socket; only when migration fails does the manager drop
//     the session and evaluate from scratch. With the fallback active it
//     behaves like the foreground below, so the changes a handoff reports in a
//     row do not leave the reserve for a direct path that dies at once.
//   - Coming back to the foreground re-dials the fallback when it is in use and
//     runs steps 1, 2 and 4 only when an improvement attempt is allowed.
//   - A path adopted again to the endpoint of the active one, same kind and
//     address, is the same path: it keeps its Since, resets no hysteresis and
//     emits no event, so the proxy keeps the streams it carries.
//   - When every step fails the manager reports the error through Connect and
//     an OnPath event with path "none", then evaluates again after
//     Timings.Retries (2, 4, 8 and 16 s) and stays offline afterwards until
//     Connect, a network change or the foreground.
//   - A revoked key, reported by the direct transport close code or by the
//     proxy after the 4401 close of the bridge, ends the manager: no further
//     attempt, and every call fails with ErrRevoked. Tor carries no close code,
//     so over the fallback only the proxy can report revocation.
//
// # Control channel
//
// The rendezvous channel follows the active path. Over a direct session the
// manager opens it on the QUIC control stream, reports the path and adopts
// every reach card the desktop renews through UpdateCard until the path is
// released. Over the fallback it exists only during step 4: RendezvousPuncher
// dials a Tor connection dedicated to it, negotiated with
// identity.ControlALPN so the onion listener of the desktop keeps it apart from
// edge connections and accepts it only from a registered key. The desktop
// sends its reach card right after hello, so each punch attempt also renews
// the card. Config.OnCard hands every adopted card to the owner to persist.
//
// # Events
//
// Config.OnPath receives the EventPathChanged payload each time a path becomes
// active, with the reason that led to it, such as ReasonPathFailed or
// ReasonPunch; the proxy closes the upstreams of the previous path. Keeping a
// path, after a successful migration, a fallback that still answers or a
// re-dial of the same endpoint, emits nothing. Losing a path emits nothing while the next step runs; only when no
// step gives a path does the manager emit KindNone with the error code as the
// reason, without repeating it while the retries fail the same way.
// Config.OnTor follows the bootstrap.
//
// # Errors
//
// Connect and DialContext fail with an *Error whose Code is one of the phone
// API codes: CodeReserveUnavailable when there is no direct path and no Tor,
// CodeReservePreparing when Tor was still bootstrapping at the end of its
// budget, CodeNoPath when Tor worked but the desktop did not answer, and
// CodeRevoked.
//
// # Replaceable pieces
//
// Paths sit behind small interfaces: DirectDialer and Migrator, implemented by
// the direct QUIC endpoint and session, TorDialer, implemented by tor.Client,
// and Puncher, implemented by RendezvousPuncher over the rendezvous channel
// and replaceable by pion ICE later.
package pathmgr
