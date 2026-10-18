import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request


SPEC = importlib.util.spec_from_file_location("pi_quota", Path(__file__).with_name("pi-quota.py"))
quota = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(quota)


def fixture():
    return {"usage": {
        "rolling": {"status": "ok", "percent": 0, "resetsAt": "2026-10-18T08:31:52.000Z"},
        "weekly": {"status": "ok", "percent": 27, "resetsAt": "2026-10-19T00:00:00.000Z"},
        "monthly": {"status": "ok", "percent": 76, "resetsAt": "2026-10-29T14:08:43.000Z"},
    }}


class SnapshotTests(unittest.TestCase):
    def test_percent_is_used_and_full_usage_means_no_quota(self):
        payload = fixture()
        payload["usage"]["rolling"].update(percent=100, status="rate-limited")
        with mock.patch.object(quota.time, "time", return_value=1234.567):
            snapshot = quota.make_snapshot(payload)
        self.assertEqual(snapshot["generatedAt"], 1234567)
        self.assertEqual(snapshot["providers"][0]["id"], "opencode-go")
        windows = snapshot["providers"][0]["windows"]
        self.assertEqual([w["label"] for w in windows], ["5h", "weekly", "monthly"])
        self.assertEqual([w["percentRemaining"] for w in windows], [0, 73, 24])
        self.assertEqual(windows[0]["resetAt"], 1792312312)

    def test_missing_or_malformed_windows_are_rejected(self):
        for payload in (None, [], {}, {"usage": []}, {"usage": {}}, {"usage": {"rolling": {}}}):
            with self.subTest(payload=payload), self.assertRaises(quota.QuotaError):
                quota.make_snapshot(payload)
        for window in quota.WINDOWS:
            for value in (None, "unexpected", []):
                payload = fixture()
                payload["usage"][window[0]] = value
                with self.subTest(window=window, value=value), self.assertRaises(quota.QuotaError):
                    quota.make_snapshot(payload)

    def test_bad_percent_never_becomes_a_plausible_quota(self):
        for value in (None, True, False, "27", -1, 101, float("nan"), float("inf"), 10 ** 400):
            payload = fixture()
            payload["usage"]["rolling"]["percent"] = value
            with self.subTest(value=value), self.assertRaises(quota.QuotaError):
                quota.make_snapshot(payload)

    def test_unknown_status_rejected(self):
        for value in (None, "error", "OK", 0):
            payload = fixture()
            payload["usage"]["weekly"]["status"] = value
            with self.subTest(value=value), self.assertRaises(quota.QuotaError):
                quota.make_snapshot(payload)

    def test_reset_requires_valid_timezone_aware_iso_timestamp(self):
        for value in (None, 123, "", "2026-10-18", "2026-10-18T08:31:52", "2026-02-30T00:00:00Z", "2026-10-18T00:00:00+00:60", "2026-10-18T00:00:00+24:00", "secret"):
            with self.subTest(value=value), self.assertRaises(quota.QuotaError):
                quota.parse_reset(value)
        self.assertEqual(quota.parse_reset("2026-10-18T16:31:52+08:00"), quota.parse_reset("2026-10-18T08:31:52Z"))
        self.assertIsInstance(quota.parse_reset("2000-01-01T00:00:00Z"), int)


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.environ = {"PI_CODING_AGENT_DIR": self.directory.name}
        self.path = Path(self.directory.name) / "auth.json"

    def write_auth(self, value):
        self.path.write_text(json.dumps(value), encoding="utf-8")

    def test_reads_only_pi_and_does_not_modify_credentials(self):
        self.write_auth({"opencode-go": {"type": "api_key", "key": "pi-test-key"}})
        before = self.path.read_bytes()
        self.environ["OPENCODE_API_KEY"] = "fallback-test-key"
        self.assertEqual(quota.load_api_key(self.environ), "pi-test-key")
        self.assertEqual(self.path.read_bytes(), before)

    def test_env_fallback_works_without_auth_file(self):
        self.environ["OPENCODE_API_KEY"] = "fallback-test-key"
        self.assertEqual(quota.load_api_key(self.environ), "fallback-test-key")

    def test_api_key_entry_without_key_uses_provider_env_fallback(self):
        self.write_auth({"opencode-go": {"type": "api_key"}})
        with self.assertRaises(quota.QuotaError):
            quota.load_api_key(self.environ)
        self.environ["OPENCODE_API_KEY"] = "fallback-test-key"
        self.assertEqual(quota.load_api_key(self.environ), "fallback-test-key")

    def test_present_non_string_key_does_not_silently_fall_back(self):
        self.environ["OPENCODE_API_KEY"] = "fallback-test-key"
        for value in (True, None, 123, []):
            self.write_auth({"opencode-go": {"type": "api_key", "key": value}})
            with self.subTest(value=value), self.assertRaises(quota.QuotaError):
                quota.load_api_key(self.environ)

    def test_utf8_bom_auth_file_matches_pi_strip_bom(self):
        self.path.write_text("\ufeff" + json.dumps({"opencode-go": {"type": "api_key", "key": "pi-test-key"}}), encoding="utf-8")
        before = self.path.read_bytes()
        self.assertEqual(quota.load_api_key(self.environ), "pi-test-key")
        self.assertEqual(self.path.read_bytes(), before)

    def test_per_entry_env_has_precedence_and_empty_uses_process(self):
        self.write_auth({"opencode-go": {"type": "api_key", "key": "$A-${B}", "env": {"A": "local", "B": ""}}})
        self.environ.update(A="process", B="value")
        self.assertEqual(quota.load_api_key(self.environ), "local-value")

    def test_missing_env_is_not_sent_as_literal_and_can_use_provider_fallback(self):
        self.write_auth({"opencode-go": {"type": "api_key", "key": "${MISSING}"}})
        with self.assertRaises(quota.QuotaError):
            quota.load_api_key(self.environ)
        self.environ["OPENCODE_API_KEY"] = "fallback-test-key"
        self.assertEqual(quota.load_api_key(self.environ), "fallback-test-key")

    def test_command_keys_never_execute_or_fall_back_silently(self):
        self.write_auth({"opencode-go": {"type": "api_key", "key": "!printf sensitive-command"}})
        self.environ["OPENCODE_API_KEY"] = "fallback-test-key"
        with self.assertRaises(quota.QuotaError) as error:
            quota.load_api_key(self.environ)
        self.assertIn("不会执行", str(error.exception))
        self.assertNotIn("sensitive-command", str(error.exception))

    def test_exact_template_escaping_and_invalid_names(self):
        self.assertEqual(quota.resolve_key_template("a$$b$!c${BAD-NAME}$9${OPEN", {}, {}), "a$b!c${BAD-NAME}$9${OPEN")
        self.assertEqual(quota.resolve_key_template("$FOO_1/$FOO", {}, {"FOO_1": "a", "FOO": "b"}), "a/b")

    def test_malformed_auth_and_unsupported_credential_are_safe_errors(self):
        for value in ([], {"opencode-go": None}, {"opencode-go": {"type": "oauth", "access": "secret"}}, {"opencode-go": {"type": "api_key", "key": True}}, {"opencode-go": {"type": "api_key", "key": "secret", "env": []}}):
            self.write_auth(value)
            with self.subTest(value=value), self.assertRaises(quota.QuotaError) as error:
                quota.load_api_key(self.environ)
            self.assertNotIn("secret", str(error.exception))
        self.path.write_text("{bad-json-with-secret", encoding="utf-8")
        with self.assertRaises(quota.QuotaError) as error:
            quota.load_api_key(self.environ)
        self.assertNotIn("secret", str(error.exception))

    def test_newline_in_key_rejected(self):
        self.write_auth({"opencode-go": {"type": "api_key", "key": "secret\nheader"}})
        with self.assertRaises(quota.QuotaError):
            quota.load_api_key(self.environ)

    def test_path_override_is_agent_directory_and_relative_paths_stay_relative(self):
        self.assertEqual(quota.agent_directory({"PI_CODING_AGENT_DIR": "relative/profile"}), Path("relative/profile"))
        self.assertEqual(quota.agent_directory({"PI_CODING_AGENT_DIR": "~"}), Path.home())
        self.assertEqual(quota.agent_directory({"PI_CODING_AGENT_DIR": "~/profile"}), Path.home() / "profile")
        self.assertEqual(quota.agent_directory({}), Path.home() / ".pi" / "agent")
        self.assertEqual(quota.agent_directory({"PI_CODING_AGENT_DIR": ""}), Path.home() / ".pi" / "agent")

    def test_local_file_urls_match_pi_path_semantics(self):
        self.assertEqual(quota.agent_directory({"PI_CODING_AGENT_DIR": "file:///tmp/pi%20profile?x=y#z"}), Path("/tmp/pi profile"))
        self.assertEqual(quota.agent_directory({"PI_CODING_AGENT_DIR": "file://localhost/tmp/pi"}), Path("/tmp/pi"))
        for value in ("file://host/tmp/pi", "file:///tmp/p%2Fi", "file:///tmp/%ZZ", "file:///tmp/%FF"):
            with self.subTest(value=value), self.assertRaises(quota.QuotaError):
                quota.agent_directory({"PI_CODING_AGENT_DIR": value})


class HttpTests(unittest.TestCase):
    def test_request_uses_verified_headers_timeout_and_no_redirect_handler(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps(fixture()).encode()
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(quota.urllib.request, "build_opener", return_value=opener) as build:
            self.assertEqual(quota.fetch_usage("synthetic-secret"), fixture())
        self.assertIsInstance(build.call_args.args[0], quota.NoRedirectHandler)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, quota.USAGE_URL)
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-secret")
        self.assertEqual(request.get_header("User-agent"), "Pi-Quota/1.0")
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 15)

    def test_redirect_handler_blocks_bearer_forwarding(self):
        handler = quota.NoRedirectHandler()
        request = urllib.request.Request(quota.USAGE_URL, headers={"Authorization": "Bearer synthetic-secret"})
        with self.assertRaises(quota.QuotaError) as error:
            handler.redirect_request(request, None, 302, "", {}, "https://example.test/steal")
        self.assertNotIn("synthetic-secret", str(error.exception))

    def test_http_error_never_displays_credential_or_response(self):
        for code in (401, 403, 429, 500):
            error = urllib.error.HTTPError(quota.USAGE_URL, code, "synthetic-secret", {}, io.BytesIO(b"synthetic-secret"))
            opener = mock.Mock()
            opener.open.side_effect = error
            with mock.patch.object(quota.urllib.request, "build_opener", return_value=opener), self.assertRaises(quota.QuotaError) as caught:
                quota.fetch_usage("synthetic-secret")
            self.assertIn(str(code), str(caught.exception))
            self.assertNotIn("synthetic-secret", str(caught.exception))

    def test_network_invalid_json_and_oversize_errors_are_safe(self):
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.URLError("synthetic-secret")
        with mock.patch.object(quota.urllib.request, "build_opener", return_value=opener), self.assertRaises(quota.QuotaError) as caught:
            quota.fetch_usage("synthetic-secret")
        self.assertNotIn("synthetic-secret", str(caught.exception))
        for body in (b"synthetic-secret", b"x" * (quota.MAX_RESPONSE_BYTES + 1)):
            response = mock.MagicMock()
            response.__enter__.return_value = response
            response.read.return_value = body
            opener.open.side_effect = None
            opener.open.return_value = response
            with mock.patch.object(quota.urllib.request, "build_opener", return_value=opener), self.assertRaises(quota.QuotaError) as caught:
                quota.fetch_usage("synthetic-secret")
            self.assertNotIn("synthetic-secret", str(caught.exception))

    def test_protocol_read_failure_is_sanitized(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = quota.http.client.IncompleteRead(b"synthetic-secret")
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(quota.urllib.request, "build_opener", return_value=opener), self.assertRaises(quota.QuotaError) as caught:
            quota.fetch_usage("synthetic-secret")
        self.assertNotIn("synthetic-secret", str(caught.exception))


class CliTests(unittest.TestCase):
    def run_cli(self, argv):
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(quota, "load_api_key", return_value="synthetic-secret"), mock.patch.object(quota, "fetch_usage", return_value=fixture()), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            result = quota.main(argv)
        return result, output.getvalue(), errors.getvalue()

    def test_default_show_json_and_widget_compatibility(self):
        result, output, errors = self.run_cli([])
        self.assertEqual(result, 0)
        self.assertIn("Go 剩余额度", output)
        self.assertIn("monthly: 24%", output)
        self.assertEqual(errors, "")
        for argv in (["show", "--json"], ["widget", "--print", "--live"]):
            result, output, errors = self.run_cli(argv)
            self.assertEqual(result, 0)
            self.assertEqual(json.loads(output)["providers"][0]["windows"][1]["percentRemaining"], 73)
            self.assertEqual(errors, "")
            self.assertNotIn("synthetic-secret", output)

    def test_failure_is_nonzero_with_no_json_snapshot(self):
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(quota, "load_api_key", side_effect=quota.QuotaError("安全错误")), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(quota.main(["widget", "--print", "--live"]), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("安全错误", errors.getvalue())

    def test_help_needs_no_credentials_or_network(self):
        with mock.patch.object(quota, "load_api_key") as load, contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as exit_info:
            quota.main(["--help"])
        self.assertEqual(exit_info.exception.code, 0)
        load.assert_not_called()


if __name__ == "__main__":
    unittest.main()
