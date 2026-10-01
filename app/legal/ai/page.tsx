import LegalPage from '../LegalPage';

export const metadata = {
  title: 'AI and Provider Information — Mento',
  description: 'Understand how Mento uses Google Gemini, OpenAI Realtime, Simli, and safety controls in its AI learning features.',
  alternates: { canonical: '/legal/ai' },
};

export default function AiInformationPage() {
  return <LegalPage title="AI and Provider Information" updated="September 14, 2026">
    <p>Mento is an AI tutor, not a human. It can misunderstand requests, produce incomplete or incorrect answers, and generate inappropriate output despite safety controls. Check important information independently.</p>
    <h2>How features work</h2>
    <ul>
      <li>Google Gemini processes Normal Chat prompts and images and generates tutoring responses.</li>
      <li>Live Tutor sends voice conversation content to OpenAI Realtime to generate realtime tutoring audio. Simli and its realtime media infrastructure render and stream the avatar.</li>
      <li>Mento applies provider safety settings, rate limits, prompt-attack detection, and abuse controls, but no control is perfect.</li>
    </ul>
    <h2>Safe use and reporting</h2>
    <p>Do not rely on Mento for emergencies or as a substitute for a qualified medical, legal, financial, or mental-health professional. Do not share highly sensitive personal information. If an answer, voice response, or avatar output seems unsafe or inappropriate, stop following it and report it in the app or contact support.</p>
    <h2>Contact</h2>
    <p>Questions or reports can be sent to <a href="mailto:mentosupport@gmail.com">mentosupport@gmail.com</a>.</p>
  </LegalPage>;
}
