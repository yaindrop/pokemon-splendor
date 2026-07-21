"""Dump states + features + net forward for JS parity testing."""

import json
import random
import sys

import torch

import engine as E
import features as F
import heuristic as H
from net import PVNet

POL = sys.argv[1] if len(sys.argv) > 1 else "ckpt/policy_frozen.json"
with open(POL) as policy_file:
    pj = json.load(policy_file)
net = PVNet(hidden=pj["meta"]["hidden"], blocks=pj["meta"]["blocks"])
net.load_state_dict({k: torch.tensor(v) for k, v in pj["weights"].items()})
net.eval()
E.load_cards()


def ser(s):
    return {
        "supply": dict(s["supply"]),
        "decks": {t: list(v) for t, v in s["decks"].items()},
        "field": {t: list(v) for t, v in s["field"].items()},
        "players": [
            {
                "tokens": dict(p["tokens"]),
                "board": list(p["board"]),
                "reserve": list(p["reserve"]),
                "buried": list(p["buried"]),
            }
            for p in s["players"]
        ],
        "turn": s["turn"],
        "round": s["round"],
        "last_round": s["last_round"],
        "np": s["np"],
    }


samples = []
g = 0
while len(samples) < 40:
    s = E.new_game(2, seed=12345 + g)
    g += 1
    plies = 0
    while not s["over"] and plies < 2000:
        if random.random() < 0.25:
            feat = F.encode(s)
            mask = F.legal_mask(s)
            P, V = net.infer(feat[None, :], mask[None, :], "cpu")
            samples.append(
                {
                    "state": ser(s),
                    "features": feat.tolist(),
                    "legal": mask.tolist(),
                    "policy": P[0].tolist(),
                    "value": float(V[0]),
                }
            )
            if len(samples) >= 40:
                break
        E.step(s, H.choose_action(s))
        plies += 1
with open("parity_states.json", "w") as parity_file:
    json.dump(samples, parity_file)
print("dumped", len(samples), "samples")
