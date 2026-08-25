import LegalPage from '../LegalPage';

export const metadata = { title: 'AI and Provider Information — Mento' };

export default function AiInformationPage() {
  return <LegalPage title="AI and Provider Information" updated="August 25, 2026">
    <p>Mento is an AI tutor, not a human. It can misunderstand requests, produce incomplete or incorrect answers, and generate inappropriate output despite safety controls. Check important information independently.</p>
    <h2>How features work</h2>
    <ul>
      <li>Google Gemini processes chat prompts and images and generates tutoring responses.</li>
      <li>Live Tutor sends voice conversation content to Gemini and sends generated response audio to Simli so an avatar can speak it.</li>
      <li>Mento applies provider safety settings, rate limits, prompt-attack detection, and abuse controls, but no control is perfect.</li>
    </ul>
    <h2>Safe use</h2>
    <p>Do not rely on Mento for emergencies or as a substitute for a qualified medical, legal, financial, or mental-health professional. Do not share highly sensitive personal information. If an answer seems unsafe or inappropriate, stop following it and report it in the app.</p>
    <h2>Contact</h2>
    <p>Questions or reports can be sent to <a href="mailto:mentosupport@gmail.com">mentosupport@gmail.com</a>.</p>
  </LegalPage>;
}
