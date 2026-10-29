#!/usr/bin/env python3
"""Independently check a grid set corrected by the spell checker.

    python3 tests/verify-spelling.py original.gridset corrected.gridset

Uses only Python's standard library, so none of the page's own code is
involved. It fails if:

  - the output ZIP is invalid, or files are missing, added or reordered
  - any file other than a page's grid.xml changed in any way, or any file date changed
  - a changed grid.xml no longer parses, or anything changed apart from text
    (elements, attributes and their order must be identical)

It then lists every changed piece of text, old -> new, for a human to read.
"""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


def fail(msg):
    print('FAIL:', msg)
    sys.exit(1)


def shape(elem):
    """Everything about an element tree except its text."""
    return (elem.tag, sorted(elem.attrib.items()), [shape(c) for c in elem])


def texts(elem, path=''):
    p = f'{path}/{elem.tag}'
    yield p, elem.text or ''
    for c in elem:
        yield from texts(c, p)
        yield p + '#tail', c.tail or ''


def main(a, b):
    za, zb = zipfile.ZipFile(a), zipfile.ZipFile(b)
    if zb.testzip() is not None:
        fail('the output ZIP is damaged')
    ia, ib = za.infolist(), zb.infolist()
    if [i.filename for i in ia] != [i.filename for i in ib]:
        fail('files were added, removed or reordered')

    changed = 0
    for x, y in zip(ia, ib):
        if x.date_time != y.date_time:
            fail(f'date changed: {x.filename}')
        da, db = za.read(x), zb.read(y)
        if da == db:
            continue
        if not re.fullmatch(r'Grids[\\/][^\\/]+[\\/]grid\.xml', x.filename, re.I):
            fail(f'a file that is not a page changed: {x.filename}')
        try:
            ta, tb = ET.fromstring(da), ET.fromstring(db)
        except ET.ParseError as e:
            fail(f'{x.filename} no longer parses: {e}')
        if shape(ta) != shape(tb):
            fail(f'{x.filename}: elements or attributes changed, not just text')
        print(f'\n{x.filename}')
        for (pa, va), (_, vb) in zip(texts(ta), texts(tb)):
            if va != vb:
                print(f'  {pa.split("/")[-1]}: {va.strip()!r} -> {vb.strip()!r}')
        # How much of the file is untouched before the first change and after the last.
        start = 0
        while start < min(len(da), len(db)) and da[start] == db[start]:
            start += 1
        end = 0
        while end < min(len(da), len(db)) - start and da[-1 - end] == db[-1 - end]:
            end += 1
        print(f'  changes between bytes {start} and {len(da) - end}; the {start + end} bytes around them are identical')
        changed += 1

    print(f'\nOK: {changed} pages changed, only their text. Everything else is identical.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
