"""Self-tests for Phase 8 saved comparison presets (CRUD + validation).

Run directly: python test_presets.py
Uses FastAPI's in-process TestClient against real MySQL; Uvicorn is never started.
"""

import io
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, r"D:\fin\market-dna\backend")

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print(f"PASS  {name}")
    else:
        print(f"FAIL  {name} {detail}")
        FAILURES.append(name)


def upload(client, name, start="2022-01-03", periods=220):
    rng = np.random.RandomState(periods)
    n = periods
    close = 100.0 * np.exp(np.cumsum(0.0008 + 0.01 * rng.normal(0.0, 1.0, n)))
    df = pd.DataFrame(
        {
            "Date": pd.bdate_range(start, periods=n),
            "Open": close * 0.999,
            "High": close * 1.002,
            "Low": close * 0.997,
            "Close": close,
            "Volume": np.full(n, 1_000_000.0),
        }
    )
    csv_bytes = df.to_csv(index=False).encode()
    response = client.post(
        "/upload", files={"file": (name, io.BytesIO(csv_bytes), "text/csv")}
    )
    assert response.status_code == 200, response.text
    return response.json()["dataset"]["id"]


def main():
    from fastapi.testclient import TestClient
    import test_support as _ts
    from main import app

    with TestClient(app) as client:

        _ts.login(client)
        ds_a = upload(client, "preset_a.csv")
        ds_b = upload(client, "preset_b.csv")
        ds_c = upload(client, "preset_c.csv")

        # CREATE.
        response = client.post(
            "/comparison-presets",
            json={"name": "Test Trio", "dataset_ids": [ds_a, ds_b, ds_c]},
        )
        body = response.json()
        preset_id = body.get("id")
        check("create: returns persisted preset", response.status_code == 200
              and isinstance(preset_id, int))
        check("create: fields echoed",
              body.get("name") == "Test Trio"
              and body.get("dataset_ids") == [ds_a, ds_b, ds_c]
              and body.get("created_at") is not None
              and body.get("updated_at") is not None)

        # READ list + single.
        listed = client.get("/comparison-presets").json()["presets"]
        check("list: contains created preset",
              any(p["id"] == preset_id for p in listed))
        fetched = client.get(f"/comparison-presets/{preset_id}").json()
        check("get by id: matches created preset", fetched == body)

        # UPDATE rename.
        renamed = client.put(
            f"/comparison-presets/{preset_id}", json={"name": "Renamed Trio"}
        ).json()
        check("update: name changed, ids preserved",
              renamed["name"] == "Renamed Trio"
              and renamed["dataset_ids"] == [ds_a, ds_b, ds_c])
        check("update: updated_at refreshed",
              renamed["updated_at"] >= renamed["created_at"])

        # UPDATE selection only.
        reselected = client.put(
            f"/comparison-presets/{preset_id}", json={"dataset_ids": [ds_a, ds_b]}
        ).json()
        check("update: ids changed, name preserved",
              reselected["dataset_ids"] == [ds_a, ds_b]
              and reselected["name"] == "Renamed Trio")

        # UPDATE with no fields rejected.
        empty = client.put(f"/comparison-presets/{preset_id}", json={})
        check("update: empty body rejected (422)", empty.status_code == 422)

        # Validation matrix on create.
        cases = [
            ("empty name", {"name": "   ", "dataset_ids": [ds_a, ds_b]}),
            ("missing name", {"dataset_ids": [ds_a, ds_b]}),
            ("missing ids", {"name": "X"}),
            ("one id only", {"name": "X", "dataset_ids": [ds_a]}),
            ("eleven ids", {"name": "X", "dataset_ids": list(range(1, 12))}),
            ("duplicate ids", {"name": "X", "dataset_ids": [ds_a, ds_a]}),
            ("non-integer ids", {"name": "X", "dataset_ids": [ds_a, "b"]}),
            ("boolean id", {"name": "X", "dataset_ids": [ds_a, True]}),
            ("ids not a list", {"name": "X", "dataset_ids": f"{ds_a},{ds_b}"}),
        ]
        for label, payload in cases:
            status = client.post("/comparison-presets", json=payload).status_code
            check(f"validation: {label} rejected (422)", status == 422,
                  f"status={status}")

        long_name = client.post(
            "/comparison-presets",
            json={"name": "x" * 121, "dataset_ids": [ds_a, ds_b]},
        )
        check("validation: 121-char name rejected (422)", long_name.status_code == 422)

        # Unknown-id handling for every route.
        missing = 998877
        check("get unknown preset -> 404",
              client.get(f"/comparison-presets/{missing}").status_code == 404)
        check("put unknown preset -> 404",
              client.put(f"/comparison-presets/{missing}",
                         json={"name": "Z"}).status_code == 404)
        check("delete unknown preset -> 404",
              client.delete(f"/comparison-presets/{missing}").status_code == 404)

        # Presets intentionally survive dataset deletion (stale ids are the
        # frontend's concern); deleting datasets must not delete presets.
        client.delete(f"/datasets/{ds_b}")
        survivor = client.get(f"/comparison-presets/{preset_id}")
        check("presets survive dataset deletion",
              survivor.status_code == 200
              and ds_b in survivor.json()["dataset_ids"])

        # DELETE preset.
        deleted = client.delete(f"/comparison-presets/{preset_id}").json()
        check("delete: reports success", deleted.get("deleted") is True)
        check("delete: preset gone afterwards",
              client.get(f"/comparison-presets/{preset_id}").status_code == 404)
        remaining = [
            p for p in client.get("/comparison-presets").json()["presets"]
            if p["id"] == preset_id
        ]
        check("delete: removed from listing", not remaining)

        # Cleanup second dataset; nothing preset-related should linger.
        client.delete(f"/datasets/{ds_a}")
        client.delete(f"/datasets/{ds_b}")

    print("-" * 60)
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} FAILURE(S): {FAILURES}")
        sys.exit(1)
    print("RESULT: ALL TESTS PASSED")


if __name__ == "__main__":
    main()
