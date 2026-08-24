"""v0.13.0 VECTOR AI engine tests (no network — the LLM call is mocked).

Covers:
  - system prompt persona constraints (Quant Vector branding, no vendor
    disclosure, visual output protocol present),
  - provider masking: /ai status and answer payloads never expose the
    underlying vendor/model strings,
  - chartable price_series tool (shape, bounds),
  - end-to-end answer path with a stubbed _call_llm.

Uses the real MySQL database like every other suite.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Controlled AI env BEFORE importing anything that reads it.
TEST_AI = {
    "AI_PROVIDER": "groq",
    "AI_API_KEY": "test-key-not-real",
    "AI_MODEL": "test-model-not-real",
}

import ai_engine  # noqa: E402

PASS, FAIL = [], []


def check(name, condition, detail=""):
    if condition:
        PASS.append(name)
        print(f"  PASS  {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL  {name} {detail}")


def _set_ai_env():
    for key, value in TEST_AI.items():
        os.environ[key] = value


def _clear_ai_env():
    for key in TEST_AI:
        os.environ.pop(key, None)


def test_prompt_persona():
    print("\n[1] system prompt persona")
    prompt = ai_engine.SYSTEM_PROMPT
    check("brands itself Vector", "VECTOR" in prompt)
    check("brands the terminal Quant Vector", "QUANT VECTOR" in prompt)
    check("no vendor names in prompt", not any(
        vendor in prompt for vendor in ("Groq", "OpenAI", "openai", "Llama", "llama", "Gemini", "Ollama")))
    check("forbids model/vendor disclosure",
          "NEVER mention" in prompt and "vendor" in prompt)
    check("identity fallback line present",
          "I'm Vector" in prompt)
    check("chart block protocol documented",
          "```chart" in prompt and '"series"' in prompt)
    check("table protocol documented", "pipe tables" in prompt or "| --- |" in prompt)
    check("grounding rule intact", "ONLY numbers present in the context" in prompt)


def test_provider_masking():
    print("\n[2] provider masking in status + answers")
    _set_ai_env()
    try:
        cfg = ai_engine.get_provider_config()
        check("provider config resolves with test env", cfg.get("configured") is True)

        status = ai_engine.ai_status()
        check("status available", status.get("available") is True)
        check("status exposes engine name", status.get("engine") == "Vector")
        check("status hides provider/model",
              "provider" not in status and "model" not in status)

        context, tools = ai_engine.build_market_context(166)
        series = context.get("price_series") or {}
        check("price_series available for seeded dataset", series.get("available") is True)
        check(
            "price_series bounded <=14 points",
            len(series.get("dates", [])) <= 14
            and series.get("dates") is not None
            and len(series.get("dates", [])) == len(series.get("closes", [])),
            str(len(series.get("dates", []))),
        )
        check("price_series in tools_used", "price_series" in tools)

        original_call = ai_engine._call_llm
        ai_engine._call_llm = lambda cfg_, q, ctx_json: (
            "| A | B |\n| --- | --- |\n| 1 | 2 |"
        )
        try:
            payload = ai_engine.answer_market_question("test question", 166)
        finally:
            ai_engine._call_llm = original_call
        check("answer path available", payload.get("available") is True)
        check("answer payload hides provider/model",
              "provider" not in payload and "model" not in payload)
        check("answer payload carries engine name", payload.get("engine") == "Vector")

        # Unconfigured state still reports honestly.
        _clear_ai_env()
        status_off = ai_engine.ai_status()
        check("offline status when unconfigured",
              status_off.get("available") is False and bool(status_off.get("reason")))
    finally:
        _clear_ai_env()

    # Vendor-free error surfacing: transport failures must not leak hosts,
    # model ids or provider responses to API clients.
    cfg_bad = {
        "configured": True, "provider": "hidden", "model": "hidden-model",
        "base_url": "https://nonexistent-host-zz9xq.test/v1",
        "api_key": "x", "has_key": True,
    }
    try:
        ai_engine._call_llm(cfg_bad, "q", "{}")
        raised = None
    except ai_engine.AIEngineError as exc:
        raised = str(exc)
    check("engine errors are sanitized",
          raised is not None and "zz9xq" not in raised and "hidden-model" not in raised
          and "provider" not in raised.lower(),
          str(raised)[:120])


if __name__ == "__main__":
    test_prompt_persona()
    test_provider_masking()
    print(f"\nRESULT: {'ALL TESTS PASSED' if not FAIL else str(len(FAIL)) + ' FAILURES'} "
          f"({len(PASS)} passed, {len(FAIL)} failed)")
    for name in FAIL:
        print("  failed:", name)
    raise SystemExit(0 if not FAIL else 1)
