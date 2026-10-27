# Independent cross-validation anchors for lib/cleaning.js (stdlib only).
# Regenerate:  python test/cleaning-crossval.py
# The expected JSON printed below is embedded in test/cleaning.test.js;
# the JS implementation must reproduce these numbers (tolerance 1e-9).
#
# This mirrors the repo's established practice (see README): stats functions
# are verified against an independent Python implementation rather than
# trusting the JS output to validate itself.
import json
import statistics

DEFAULTS = dict(cvThreshold=0.05, deviationThreshold=0.5, minReplicates=1,
                missingRule='exclude', imputeCq=40)


def missing_reason(well):
    call, cq = well.get('call'), well.get('cq')
    if call == 'Negative':
        return 'negative'
    if call == 'Invalid':
        return 'invalid'
    if call == 'Positive':
        return None if isinstance(cq, (int, float)) else 'no_cq'
    return 'undetermined'


def clean_group(group, o):
    wells = [dict(id=w['id'], label=w.get('label', str(w['id'])), cq=w.get('cq'),
                  call=w.get('call'), status='pending', reason='') for w in group['wells']]
    kept, imputed = [], []
    for w in wells:
        reason = missing_reason(w)
        if reason is None:
            w['status'] = 'used'
            kept.append(w)
        elif o['missingRule'] == 'impute':
            w['status'] = 'imputed'
            w['reason'] = 'imputed_' + reason
            w['cq'] = o['imputeCq']
            imputed.append(w)
        else:
            w['status'] = 'excluded'
            w['reason'] = reason

    min_keep = max(1, o['minReplicates'])
    while len(kept) > min_keep:
        vals = [w['cq'] for w in kept]
        med = statistics.median(vals)
        m = sum(vals) / len(vals)
        max_dev = max(abs(v - med) for v in vals)
        cv = statistics.stdev(vals) / abs(m) if m != 0 else float('nan')
        if not (cv > o['cvThreshold'] or max_dev > o['deviationThreshold']):
            break
        idx = 0
        for i in range(1, len(kept)):
            di, d0 = abs(kept[i]['cq'] - med), abs(kept[idx]['cq'] - med)
            if di > d0 or (di == d0 and abs(kept[i]['cq'] - m) > abs(kept[idx]['cq'] - m)):
                idx = i
        removed = kept.pop(idx)
        removed['status'] = 'excluded'
        removed['reason'] = 'outlier'

    all_wells = kept + imputed
    n = len(all_wells)
    m = sum(w['cq'] for w in all_wells) / n if n else float('nan')
    sd = statistics.stdev([w['cq'] for w in all_wells]) if n > 1 else (0.0 if n == 1 else float('nan'))
    cv = sd / abs(m) if n and m != 0 else float('nan')
    warnings = []
    if n == 0:
        warnings.append('all_replicates_missing')
    elif len(kept) == 0:
        warnings.append('all_replicates_imputed')
    return dict(sample=group['sample'], target=group['target'], n=n, mean=m, sd=sd, cv=cv,
                nOutliers=sum(1 for w in wells if w['reason'] == 'outlier'),
                nMissing=sum(1 for w in wells if w['status'] == 'excluded' and w['reason'] != 'outlier'),
                nImputed=sum(1 for w in wells if w['status'] == 'imputed'),
                wells=wells, warnings=warnings, usable=n > 0)


def clean(groups, **overrides):
    o = dict(DEFAULTS)
    o.update(overrides)
    cleaned = [clean_group(g, o) for g in groups]
    stats_input = [dict(sample=g['sample'], target=g['target'], mean=g['mean'],
                        sd=g['sd'], cv=g['cv'], n=g['n']) for g in cleaned if g['usable']]
    warnings = [w + ': ' + g['sample'] + ' / ' + g['target']
                for g in cleaned for w in g['warnings']]
    return dict(groups=cleaned, statsInput=stats_input, warnings=warnings)


def w(cid, cq, call='Positive', label=None):
    d = dict(id=cid, cq=cq, call=call)
    if label:
        d['label'] = label
    return d


SCENARIOS = {
    # 1. recovery: exact mean/SD from replicates with known design spread
    'recovery': clean([dict(sample='S1', target='T', wells=[w(1, 19.8), w(2, 20.0), w(3, 20.2)])]),
    # 2. one injected outlier is flagged, removed, and excluded from stats input
    'outlier': clean([dict(sample='S2', target='T',
                           wells=[w(1, 20.0), w(2, 20.1), w(3, 20.2), w(4, 15.9)])]),
    # 3. iterative removal under a high-CV group, stopping at the thresholds
    'highcv': clean([dict(sample='S3', target='T',
                          wells=[w(1, 19.0), w(2, 20.0), w(3, 21.0), w(4, 22.0)])]),
    # 4. keep at least one well even when every pair is discordant
    'keepOne': clean([dict(sample='S4', target='T', wells=[w(1, 15.0), w(2, 25.0)])]),
    # 5. Negative/Invalid wells are excluded by default, with reasons
    'missing': clean([dict(sample='S5', target='T',
                           wells=[w(1, 20.0), w(2, 20.2), w(3, None, 'Negative'), w(4, None, 'Invalid')])]),
    # 6. same group under the Cq=40 imputation rule
    'impute': clean([dict(sample='S5', target='T',
                          wells=[w(1, 20.0), w(2, 20.2), w(3, None, 'Negative'), w(4, None, 'Invalid')])],
                    missingRule='impute'),
    # 7. a group whose replicates are all undetermined warns instead of
    #    silently entering statistics
    'allMissing': clean([dict(sample='S6', target='T', wells=[w(1, None, 'Negative'), w(2, None, 'Invalid')]),
                         dict(sample='S7', target='T', wells=[w(3, 21.0), w(4, 21.1)])]),
}

print(json.dumps(SCENARIOS, ensure_ascii=False, indent=1, allow_nan=True))
