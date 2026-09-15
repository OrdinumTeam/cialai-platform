// SPDX-License-Identifier: Apache-2.0
package br.com.ordinum.cialai.tunnel

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TorControlRepliesTest {
  @Test
  fun readsTheGetInfoValueOfTheRequestedKey() {
    val lines = listOf("status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=45 TAG=loading_descriptors", "OK")
    assertEquals("NOTICE BOOTSTRAP PROGRESS=45 TAG=loading_descriptors", TorControlReplies.value("status/bootstrap-phase", lines))
    assertNull(TorControlReplies.value("net/listeners/socks", lines))
  }

  @Test
  fun picksTheFirstLoopbackSocksListener() {
    assertEquals("127.0.0.1:9050", TorControlReplies.socksListener("\"127.0.0.1:9050\""))
    assertEquals("127.0.0.1:41823", TorControlReplies.socksListener("\"unix:/data/tor/socks\" \"127.0.0.1:41823\""))
    assertEquals("[::1]:9150", TorControlReplies.socksListener("\"[::1]:9150\""))
    assertNull(TorControlReplies.socksListener(""))
    assertNull(TorControlReplies.socksListener("\"0.0.0.0:9050\""))
    assertNull(TorControlReplies.socksListener("\"127.0.0.1:0\""))
    assertNull(TorControlReplies.socksListener("\"unix:/data/tor/socks\""))
  }

  @Test
  fun readsTheBootstrapProgress() {
    assertEquals(0, TorControlReplies.bootstrapProgress("NOTICE BOOTSTRAP PROGRESS=0 TAG=starting SUMMARY=\"Starting\""))
    assertEquals(100, TorControlReplies.bootstrapProgress("NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY=\"Done\""))
    assertEquals(
      10,
      TorControlReplies.bootstrapProgress("WARN BOOTSTRAP PROGRESS=10 TAG=conn_done WARNING=\"Network is unreachable\" COUNT=3")
    )
    assertNull(TorControlReplies.bootstrapProgress("NOTICE CIRCUIT_ESTABLISHED"))
    assertNull(TorControlReplies.bootstrapProgress("NOTICE BOOTSTRAP PROGRESS=180 TAG=done"))
  }
}

class LanReportTest {
  private val target = LanTarget("d_AAAAAAAAAAAAAAAAAAAAAA", "0011223344556677")

  @Test
  fun reportsOnlyTheExpectedDesktopWithItsFingerprint() {
    val services = listOf(
      LanService(target.desktopId, target.fingerprint, 4740, listOf("192.168.1.20", "fe80::1%wlan0")),
      LanService("d_BBBBBBBBBBBBBBBBBBBBBB", target.fingerprint, 4740, listOf("192.168.1.30")),
      LanService(target.desktopId, "ffffffffffffffff", 4740, listOf("192.168.1.40")),
      LanService(target.desktopId, target.fingerprint, 0, listOf("192.168.1.50"))
    )
    val entries = LanReport.entries(target, services)
    assertEquals(listOf("192.168.1.20", "fe80::1%wlan0"), entries.map { it.host })
    val json = JSONArray(LanReport.json(entries))
    assertEquals(2, json.length())
    val first = json.getJSONObject(0)
    assertEquals(setOf("host", "port", "id", "fp"), first.keys().asSequence().toSet())
    assertEquals(4740, first.getInt("port"))
    assertEquals(target.desktopId, first.getString("id"))
    assertEquals(target.fingerprint, first.getString("fp"))
  }

  @Test
  fun capsTheReportAndDropsRepeats() {
    val hosts = (1..12).map { "10.0.0.$it" }
    val services = listOf(
      LanService(target.desktopId, target.fingerprint, 4740, hosts),
      LanService(target.desktopId, target.fingerprint, 4740, listOf("10.0.0.1"))
    )
    assertEquals(LanReport.MAX_ENTRIES, LanReport.entries(target, services).size)
    assertEquals("[]", LanReport.json(emptyList()))
  }
}
