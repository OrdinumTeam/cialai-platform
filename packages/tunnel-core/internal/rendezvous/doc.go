// SPDX-License-Identifier: Apache-2.0
// Package rendezvous is the per-session control channel between a phone and a
// desktop. It exchanges fresh direct candidates, coordinates the NAT punch,
// renews the reach card, reports the chosen path and keeps the channel alive.
// Its main use is negotiating a direct path when neither side accepts inbound
// connections, with Tor as the meeting point.
//
// # Carriers
//
// The channel runs on any authenticated byte stream: the QUIC control stream
// of a direct session, through Open on the phone and Accept on the desktop,
// or a mutual TLS connection over Tor, through Establish. The transport
// already proved both keys; hello only binds the channel to them. When the
// stream belongs to a transport.Session, the peer key comes from that session.
// Over Tor the stream is one onion connection dedicated to the channel: the
// phone negotiates identity.ControlALPN, and the onion listener of the desktop
// hands such connections, from registered keys only, to AcceptControl instead
// of the edge, so Accept serves them like the QUIC control stream.
//
// # Frames
//
// Each frame is a 4-byte big-endian length followed by that many bytes of JSON,
// at most MaxFrameSize (16 KiB). The length is checked before the payload is
// read. Decoding is strict: no unknown fields, no trailing data, exactly the
// body named by the type and every field valid. An invalid or oversized frame
// closes the channel with ErrInvalidFrame or ErrFrameTooLarge, because a byte
// stream cannot resynchronize after it.
//
//	{"type":"candidates","seq":2,"candidates":{"ttlMs":120000,"list":[{"t":"stun","a":"203.0.113.7:40000"}]}}
//
// # Messages
//
//	type           sender    body
//	hello          both      proto, role and key; always the first frame
//	candidates     both      ttlMs and list of QR candidates
//	punch_request  phone     candidates: seq of the phone list to punch
//	punch_ack      desktop   request: seq of the request; accepted or reason
//	reach_update   desktop   the reach card, whose key must be the desktop key
//	path_report    phone     path, address, rttMs and reason
//	ping           both      none
//	pong           both      ping: seq of the ping
//
// A message from the wrong role, a frame before hello or a second hello closes
// the channel with ErrProtocol. Sending a message the local role may not send
// fails without closing it.
//
// # Order and repetition
//
// Each side numbers its frames from 1, hello included, and the receiver
// requires exactly the next number: a repeated or older number closes the
// channel with ErrReplay and a skipped one with ErrProtocol. Answers name the
// frame they answer, so an acknowledgement or pong that matches no pending
// request is ErrReplay, or ErrProtocol when it names a frame never sent. An
// answer that arrives after its caller gave up is dropped quietly. Both sides
// send hello at once, so the exchange costs a single round trip over Tor.
//
// # Candidate expiry
//
// A candidate list carries a TTL between MinCandidateTTL and MaxCandidateTTL,
// DefaultCandidateTTL by default. The receiver counts it from the arrival, so
// the clocks of the two devices do not need to agree. A newer list replaces
// the previous one, and an empty list withdraws it. LocalCandidates and
// PeerCandidates only return fresh lists.
//
// # Punch
//
// The phone sends its candidates, reflected by STUN through the socket it
// dials from, and calls Punch, which waits for fresh desktop candidates and
// sends punch_request naming the phone list. The desktop checks that the list
// is its latest and fresh, starts transport.Puncher.Punch toward it and
// answers punch_ack; it refuses stale, expired or empty lists, a second punch
// while one runs and punches without a puncher. On acceptance the phone calls
// transport.Puncher.DialCandidates toward the desktop list and returns the
// first session. Both steps sit behind transport.Puncher, so pion ICE can
// replace the built-in puncher without touching this package.
//
// # Keepalive
//
// Each side pings every PingInterval and closes the channel with
// ErrIdleTimeout when nothing arrives for IdleTimeout. Ping measures the
// round trip on demand. Pongs and acknowledgements are written ahead of
// queued messages; a peer that keeps asking without reading the answers
// closes the channel.
//
// # Use
//
// The phone path manager opens the channel on the Tor fallback, sends fresh
// candidates, calls Punch within its budget, reports the result with
// ReportPath and stores the cards received through Handler.ReachUpdate; over
// a direct session it keeps the channel open on the QUIC control stream for
// the card renewals. The desktop sidecar accepts the channel on both carriers,
// sends the reach card with SendReachUpdate and then its candidates after
// hello and whenever the collector reports a change, serves punches with its
// QUIC endpoint as the puncher and relays Handler.PathReport as session state.
//
// The tests use a fake transport and the real QUIC and onion TLS carriers over
// loopback, which has no NAT. Punching through real gateways is not verified
// yet.
package rendezvous
