// 이제 Vercel이 키움 서버에 직접 연결하지 않고,
// 고정 IP를 가진 중계 서버(Vultr)를 통해서 데이터를 가져옵니다.
// 중계 서버 주소는 아래 RELAY_URL에서 바꿀 수 있습니다.

const RELAY_URL = process.env.KIWOOM_RELAY_URL || "http://141.164.40.229:3000";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const code = String(req.query?.code || "000660").trim();

  try {
    const r = await fetch(`${RELAY_URL}/flow-oscillator?code=${encodeURIComponent(code)}`);
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(200).json({ error: true, message: "중계 서버 연결 실패: " + String(e && e.message ? e.message : e) });
  }
};
