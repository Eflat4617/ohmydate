#!/usr/bin/env python3
"""Render a review packet from docs/orchestration/packets/_REVIEW_TEMPLATE.md.
usage: make-review-packet.py <ID> <branch> <base> <head> <claims-file> <out>"""
import sys
ID, BR, BASE, HEAD, CLAIMS, OUT = sys.argv[1:7]
t = open("docs/orchestration/packets/_REVIEW_TEMPLATE.md").read()
for k, v in {"{ID}": ID, "{BRANCH}": BR, "{BASE}": BASE, "{HEAD}": HEAD, "{CLAIMS}": open(CLAIMS).read()}.items():
    t = t.replace(k, v)
open(OUT, "w").write(t)
