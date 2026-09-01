export default async function handler(req, res) {
  const CNBC = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US10Y&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
  const num = s => Number(String(s).replace('%', '').replace(/,/g, ''));

  try {
    const r = await fetch(CNBC, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        'Referer': 'https://www.cnbc.com/quotes/US10Y'
      }
    });
    if (!r.ok) throw new Error('cnbc ' + r.status);
    const j = await r.json();
    const q = j && j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote && j.FormattedQuoteResult.FormattedQuote[0];
    if (!q || !q.last) throw new Error('cnbc empty');

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      source: 'cnbc',
      yield: num(q.last),
      changePts: num(q.change),
      prevClose: num(q.previous_day_closing),
      quoteTime: q.last_timedate || '',
      live: true
    });
  } catch (e) {
    try {
      const y = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const yj = await y.json();
      const m = yj && yj.chart && yj.chart.result && yj.chart.result[0] && yj.chart.result[0].meta;
      if (!m) throw new Error('yahoo empty');
      const price = m.regularMarketPrice;
      const prev = m.chartPreviousClose;
      return res.status(200).json({
        source: 'yahoo',
        yield: price,
        changePts: Number((price - prev).toFixed(3)),
        prevClose: prev,
        quoteTime: '',
        live: true
      });
    } catch (e2) {
      return res.status(500).json({ error: String(e.message), live: false });
    }
  }
}
