import type {
  LineItem,
  Party,
  RawExtractedInvoiceData,
  ValidationRuleCode,
  VatBreakdown,
  VatCategoryCode,
} from '@pdf-to-xrechnung/contracts';

export const de = {
  app: {
    title: 'PDF zu XRechnung',
    description:
      'PDF-Rechnungen in XRechnung (EN 16931) umwandeln — mit Prüfung und Korrektur vor dem Download.',
  },
  demoNotice:
    'Demomodus: Es werden feste Beispieldaten verwendet. Die Werte aus Ihrem PDF werden nicht ausgelesen.',
  theme: {
    switchToLight: 'Helles Design',
    switchToDark: 'Dunkles Design',
  },
  locale: {
    switchLabel: 'Sprache',
    de: 'Deutsch',
    en: 'Englisch',
  },
  common: {
    loading: 'Wird geladen …',
    retry: 'Erneut versuchen',
    openInNewTab: 'In neuem Tab öffnen',
    download: 'Herunterladen',
  },
  upload: {
    title: 'Rechnung hochladen',
    dropzoneHint: 'PDF hierher ziehen oder Datei auswählen',
    dropzoneActive: 'Datei hier ablegen',
    uploading: 'Wird hochgeladen …',
    invalidType: 'Nur PDF-Dateien werden unterstützt.',
    tooLarge: (maxMb: number) => `Die Datei ist größer als ${maxMb} MB.`,
    deduplicatedNotice: (filename: string) =>
      `Diese Datei liegt bereits als „${filename}“ in der Liste — sie ist unten hervorgehoben.`,
    deduplicatedNoticeUnnamed: 'Diese Datei liegt bereits in der Liste.',
    listTitle: 'Meine Rechnungen',
    expiresInMinutes: (minutes: number) => `noch ${minutes} Min.`,
    expiresInHours: (hours: number) => `noch ${hours} Std.`,
    expiresInHoursMinutes: (hours: number, minutes: number) =>
      `noch ${hours} Std. ${minutes} Min.`,
    expiredNotice: 'Abgelaufen',
    emptyTitle: 'Aus einer PDF-Rechnung eine XRechnung machen',
    emptyIntro:
      'Die Daten werden aus dem PDF ausgelesen, rechnerisch und formal geprüft und als XRechnung (EN 16931, CIUS XRechnung 3.0.2) erzeugt. Was die Prüfung nicht bestätigen kann, wird nicht geraten, sondern zur Korrektur vorgelegt.',
    emptyPoints: [
      'PDFs mit Textebene und gut lesbare Scans werden unterstützt.',
      'Kein Konto, keine Anmeldung.',
      'Dokument, Text und erzeugte XML werden nach zwei Stunden gelöscht.',
    ],
    groups: {
      needsReview: 'Erfordert Prüfung',
      inProgress: 'In Bearbeitung',
      ready: 'Fertig',
      failed: 'Fehlgeschlagen',
    },
    delete: {
      action: 'Rechnung löschen',
      title: 'Rechnung löschen?',
      body: (filename: string) =>
        `„${filename}“ wird mit dem PDF und allen daraus erzeugten Daten gelöscht.`,
      confirm: 'Löschen',
      cancel: 'Abbrechen',
      failed: 'Die Rechnung konnte nicht gelöscht werden.',
    },
  },
  pipeline: {
    stepOf: (current: number, total: number) =>
      `Schritt ${current} von ${total}`,
    stage: {
      uploaded: { done: 'Hochgeladen', active: 'Wird hochgeladen' },
      text: { done: 'Text gelesen', active: 'Text wird gelesen' },
      data: { done: 'Daten erkannt', active: 'Daten werden erkannt' },
      checked: { done: 'Geprüft', active: 'Wird geprüft' },
      generated: {
        done: 'XRechnung erstellt',
        active: 'XRechnung wird erstellt',
      },
    },
    stageState: {
      done: 'abgeschlossen',
      active: 'läuft',
      pending: 'ausstehend',
      stopped: 'wartet auf Korrektur',
      failed: 'fehlgeschlagen',
    },
    fact: {
      pages: (pageCount: number, sourceType: string) =>
        `${pageCount === 1 ? '1 Seite' : `${pageCount} Seiten`} · ${sourceType}`,
      lineItems: (count: number) =>
        count === 1 ? '1 Position erkannt' : `${count} Positionen erkannt`,
      checks: (passed: number, failed: number) =>
        failed === 0
          ? `Alle ${passed} Prüfungen bestanden`
          : `${passed} von ${passed + failed} Prüfungen bestanden`,
      kositAccepted: 'Vom offiziellen KoSIT-Validator akzeptiert',
    },
    outcome: {
      running: 'Die Rechnung wird verarbeitet.',
      needsReview:
        'Die Prüfung hat offene Angaben in den Rechnungsdaten gefunden. Bitte korrigieren.',
      needsReviewMapping:
        'Die Daten sind in sich schlüssig, lassen sich aber nicht als XRechnung abbilden. Bitte korrigieren.',
      ready: 'Die XRechnung wurde erzeugt.',
      failed: 'Die Verarbeitung ist fehlgeschlagen.',
    },
  },
  sourceType: {
    NATIVE: 'Textebene',
    OCR: 'OCR (Texterkennung)',
    UNKNOWN: 'Unbekannt',
  },
  severity: {
    ERROR: 'Fehler',
    WARNING: 'Warnung',
    INFO: 'Hinweis',
  },
  pipelineStage: {
    'text-extraction': 'Textextraktion',
    'data-extraction': 'Datenextraktion',
    validation: 'Validierung',
    generation: 'Erzeugung',
  },
  failure: {
    pdfUnreadable:
      'Der PDF-Text konnte nicht gelesen werden. Die Datei ist möglicherweise beschädigt oder passwortgeschützt.',
    pdfNoPages: 'Das PDF enthält keine Seiten.',
    pdfResourceLimit:
      'Das PDF überschreitet die unterstützten Verarbeitungsgrenzen.',
    pdfTooManyPages: (pageCount: number, limit: number) =>
      `Das PDF hat ${pageCount} Seiten und überschreitet das Limit von ${limit} Seiten.`,
    ocrTextTooSparse: (pages: number[]) =>
      `Die Texterkennung hat auf ${pages.length === 1 ? `Seite ${pages[0]}` : `den Seiten ${pages.join(', ')}`} nicht genügend lesbaren Text erkannt.`,
    ocrConfidenceTooLow: (lowestPageConfidence: number, minimum: number) =>
      `Die Qualität der Texterkennung (${lowestPageConfidence.toFixed(1)} %) liegt unter dem erforderlichen Wert von ${minimum} %.`,
    textTooLong: (charCount: number, limit: number) =>
      `Der gelesene Text hat ${charCount} Zeichen und überschreitet das Limit von ${limit} Zeichen.`,
    textExtractionRetriesExhausted:
      'Die Textextraktion konnte nach mehreren Versuchen nicht abgeschlossen werden.',
    llmProviderError:
      'Die Datenerkennung konnte wegen eines Anbieterfehlers nicht abgeschlossen werden.',
    llmResponseNotJson:
      'Die Antwort der Datenerkennung war auch nach einem Korrekturversuch kein gültiges JSON.',
    llmResponseSchemaMismatch:
      'Die Antwort der Datenerkennung entsprach auch nach einem Korrekturversuch nicht dem erwarteten Format.',
    llmResponseTruncated:
      'Die Antwort der Datenerkennung wurde wegen der Länge der Rechnung abgeschnitten.',
    llmNoUsableData:
      'Die Datenerkennung hat keine verwendbaren Daten geliefert. Das Dokument ist vermutlich keine Rechnung.',
    dataExtractionRetriesExhausted:
      'Die Datenerkennung konnte nach mehreren Versuchen nicht abgeschlossen werden.',
    validationRetriesExhausted:
      'Die Rechnungsprüfung konnte nach mehreren Versuchen nicht abgeschlossen werden.',
    generationRetriesExhausted:
      'Die XRechnung-Erzeugung konnte nach mehreren Versuchen nicht abgeschlossen werden.',
  },
  review: {
    backToList: 'Zurück zur Übersicht',
    sourceTitle: 'Quelldokument',
    noFindings: 'Keine Prüfergebnisse.',
    passedLabel: 'Bestanden',
    expectedLabel: 'Erwartet',
    actualLabel: 'Tatsächlich',
    generalFinding: 'Allgemein',
    correctionTitle: 'Korrektur',
    ocrNotice:
      'Dieser Beleg wurde per Texterkennung gelesen. Prüfen Sie alle Angaben besonders sorgfältig gegen das Original.',
    submitting: 'Wird gesendet …',
    formDisabledNotice: 'Diese Rechnung kann derzeit nicht bearbeitet werden.',
    statusTitle: 'Status',
    failureLabel: 'Fehlerursache',
    deadLetterNotice: (stage: string, failedAt: string) =>
      `Verarbeitung fehlgeschlagen bei „${stage}“ am ${failedAt}.`,
    retryButton: 'Erneut versuchen',
    retryQueuedNotice: 'Erneuter Versuch angestoßen — die Verarbeitung läuft.',
    retryGaveUpNotice:
      'Der erneute Versuch hat den Status nicht verändert. Bitte die Seite neu laden oder es später erneut versuchen.',
    downloadXml: 'XRechnung herunterladen',
    evidenceTitle: 'Alle Prüfungen',
    blockingTitle: (count: number) =>
      count === 1
        ? '1 Angabe blockiert die Erzeugung'
        : `${count} Angaben blockieren die Erzeugung`,
    requiredLabel: 'Erforderlich',
    blockingHint: 'Zum betroffenen Feld springen:',
    formatIssuesTitle:
      'Bitte zuerst die Eingabeformate korrigieren — diese Werte können nicht gesendet werden.',
    hideSource: 'Beleg ausblenden',
    showSource: 'Beleg einblenden',
    tabSource: 'Beleg',
    tabReview: 'Prüfung',
    contactDetails: (party: string) =>
      `Kontakt und elektronische Adresse (${party})`,
    identifiersHint:
      'USt-IdNr. (BT-31) und Steuernummer (BT-32) sind zwei verschiedene Kennungen. Für die XRechnung wird die USt-IdNr. benötigt.',
    contactHint:
      'Elektronische Adresse und Schema sind die technische Zustelladresse im E-Rechnungs-Netzwerk, kein Kontakt — das Schema legt fest, wie der Wert zu lesen ist (z. B. USt-IdNr., E-Mail). Ansprechpartner, Telefon und E-Mail sind die menschliche Kontaktperson für Rückfragen zu dieser Rechnung. XRechnung verlangt einen benannten Ansprechpartner nur beim Verkäufer (BG-6) — beim Käufer sind diese drei Felder optional.',
    selectPlaceholder: 'Bitte wählen …',
    unrecognizedOptionLabel: (value: string) => `${value} (nicht erkannt)`,
    expiresLabel: 'Verfügbar',
    reviewAndSubmit: 'Prüfen und absenden',
    confirmTitle: 'Prüfen und absenden',
    confirmChanged: (count: number) =>
      count === 1 ? '1 Änderung' : `${count} Änderungen`,
    confirmNoChanges:
      'Es wurde nichts geändert. Die Daten werden unverändert erneut geprüft.',
    confirmRecheckedTitle: 'Wird erneut geprüft',
    confirmRecheckedHint:
      'Diese Angaben betreffen Felder, die Sie geändert haben. Ob sie behoben sind, entscheidet die Prüfung auf dem Server.',
    confirmUntouchedTitle: 'Nicht bearbeitet',
    confirmUntouchedHint:
      'Diese Angaben betreffen kein geändertes Feld und bleiben deshalb bestehen.',
    confirmFinalCheckHint:
      'Prüfen Sie vor dem Absenden noch einmal alle Felder gegen das Originaldokument — nicht nur die hervorgehobenen.',
    confirmBack: 'Zurück zur Korrektur',
    confirmSubmit: 'Absenden',
    emptyValue: 'leer',
    submitResultGenerating:
      'Korrektur übernommen — die XRechnung wird jetzt erzeugt.',
    submitResultNeedsReview:
      'Korrektur gespeichert, aber es bleiben Fehler offen. Die Prüfergebnisse unten sind aktualisiert.',
    loadFailedTitle: 'Ansicht nicht aktuell',
    readyDisclaimer:
      'Die XRechnung entspricht EN 16931 und wurde vom offiziellen KoSIT-Validator akzeptiert. Damit ist nicht geprüft, ob die Daten mit dem PDF übereinstimmen — dafür ist die Prüfung oben da.',
    lineItemsHint:
      'Eine Position nur entfernen, wenn sie fälschlich erkannt wurde und nicht wirklich auf der Rechnung steht — fehlt eine echte Position, fügen Sie sie stattdessen hinzu.',
    lineItemsLimit: (limit: number) =>
      `Es sind höchstens ${limit} Positionen zulässig.`,
    addLineItem: 'Position hinzufügen',
    removeLineItem: (index: number) => `Position ${index} entfernen`,
    vatBreakdownHint:
      'Eine Steuersatzgruppe nur entfernen, wenn sie fälschlich erkannt wurde und nicht wirklich auf der Rechnung steht — fehlt eine echte Gruppe, fügen Sie sie stattdessen hinzu.',
    vatBreakdownLimit: (limit: number) =>
      `Es sind höchstens ${limit} Steuersatzgruppen zulässig.`,
    addVatBreakdown: 'Steuersatzgruppe hinzufügen',
    removeVatBreakdown: (index: number) =>
      `Steuersatzgruppe ${index} entfernen`,
    positionLabel: (index: number) => `Position ${index}`,
    vatGroupLabel: (index: number) => `Steuersatzgruppe ${index}`,
    vatCategoryHint:
      'Wählen Sie die auf der Rechnung ausgewiesene steuerliche Behandlung für diese Steuersatzgruppe. Bei 0 % ist die Angabe erforderlich.',
    vatCategoryReasonHint:
      'Der Befreiungsgrund oben ist der auf der Rechnung gedruckte Wortlaut — er bleibt als Beleg neben der gewählten Kategorie sichtbar.',
    vatCategoryOptions: {
      S: 'Regelbesteuerung',
      AE: 'Reverse-Charge — Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)',
      K: 'Innergemeinschaftliche Lieferung',
      G: 'Ausfuhrlieferung (Drittland)',
      E: 'Steuerbefreit (§ 4 UStG)',
      Z: 'Nullsatz (0 %)',
    } satisfies Record<VatCategoryCode, string>,
    vatCategoryResolvedReason: (category: VatCategoryCode): string | null => {
      switch (category) {
        case 'AE':
          return 'Wird übermittelt als: Steuerschuldnerschaft des Leistungsempfängers.';
        case 'K':
          return 'Wird übermittelt als: innergemeinschaftliche Lieferung.';
        case 'G':
          return 'Wird übermittelt als: Ausfuhrlieferung.';
        case 'S':
        case 'E':
        case 'Z':
          return null;
      }
    },
    groups: {
      header: 'Rechnungskopf',
      seller: 'Verkäufer',
      buyer: 'Käufer',
      lineItems: 'Rechnungspositionen',
      vatBreakdown: 'Umsatzsteueraufschlüsselung',
      totals: 'Summen',
    },
  },
  fields: {
    invoiceNumber: 'Rechnungsnummer', // BT-1
    issueDate: 'Rechnungsdatum', // BT-2
    dueDate: 'Fälligkeitsdatum', // BT-9
    deliveryDate: 'Leistungsdatum', // BT-72
    currency: 'Währung', // BT-5
    sellerIban: 'IBAN', // BT-84
    sellerBic: 'BIC', // BT-86
    netTotal: 'Nettosumme', // BT-106
    vatTotal: 'Umsatzsteuergesamtbetrag', // BT-110
    grossTotal: 'Rechnungsendbetrag', // BT-112
    paymentTerms: 'Zahlungsbedingungen', // BT-20
    buyerReference: 'Leitweg-ID', // BT-10, mandatory per BR-DE-15 — not "reference number"
    seller: 'Verkäufer', // BG-4
    buyer: 'Käufer', // BG-7
    lineItems: 'Rechnungspositionen', // BG-25
    vatBreakdown: 'Umsatzsteueraufschlüsselung', // BG-23
  } satisfies Record<keyof RawExtractedInvoiceData, string>,
  party: {
    name: 'Name', // BT-27 seller / BT-44 buyer
    street: 'Straße', // BT-35 seller / BT-50 buyer
    postalCode: 'Postleitzahl', // BT-38 seller / BT-53 buyer
    city: 'Ort', // BT-37 seller / BT-52 buyer
    countryCode: 'Land', // BT-40 seller / BT-55 buyer
    vatId: 'USt-IdNr.', // BT-31 seller / BT-48 buyer — distinct from taxNumber
    taxNumber: 'Steuernummer', // BT-32 seller; EN 16931 has no distinct buyer term
    electronicAddress: 'Elektronische Adresse', // BT-34 seller / BT-49 buyer
    electronicAddressScheme: 'Schema der elektronischen Adresse', // BT-34/BT-49 scheme id (BR-62/BR-63)
    contactName: 'Ansprechpartner', // BT-41 seller / BT-56 buyer
    contactEmail: 'E-Mail', // BT-43 seller / BT-58 buyer
    contactPhone: 'Telefon', // BT-42 seller / BT-57 buyer
  } satisfies Record<keyof Party, string>,
  lineItem: {
    position: 'Position', // BT-126
    description: 'Bezeichnung', // BT-153
    quantity: 'Menge', // BT-129
    unit: 'Einheit', // BT-130
    unitPrice: 'Einzelpreis', // BT-146
    netAmount: 'Nettobetrag', // BT-131
    vatRate: 'USt-Satz', // BT-152 — line-level rate, distinct from BT-119
    vatExemptionReason: 'Befreiungsgrund', // no distinct line-level BT in EN 16931
  } satisfies Record<keyof LineItem, string>,
  vatBreakdownField: {
    rate: 'USt-Satz', // BT-119 — category-level rate, distinct from BT-152
    base: 'Bemessungsgrundlage', // BT-116
    amount: 'USt-Betrag', // BT-117
    category: 'Steuerkategorie', // BT-118 — UNCL5305 code, chosen by the reviewer
    exemptionReason: 'Befreiungsgrund (Text)', // BT-120
  } satisfies Record<keyof VatBreakdown, string>,
  rules: {
    'arithmetic.line_net':
      'Menge × Einzelpreis muss dem Nettobetrag der Position entsprechen.',
    'arithmetic.line_sum':
      'Die Summe der Positions-Nettobeträge muss der Nettosumme entsprechen.',
    'arithmetic.vat_amount':
      'Bemessungsgrundlage × USt-Satz muss dem USt-Betrag je Steuersatzgruppe entsprechen.',
    'arithmetic.vat_base_sum':
      'Die Summe der Bemessungsgrundlagen muss der Nettosumme entsprechen.',
    'arithmetic.vat_total':
      'Die Summe der USt-Beträge muss dem Umsatzsteuergesamtbetrag entsprechen.',
    'arithmetic.gross':
      'Nettosumme + Umsatzsteuergesamtbetrag muss dem Rechnungsendbetrag entsprechen.',
    'format.calendar_date':
      'Das Datum muss ein gültiges Kalenderdatum im Format JJJJ-MM-TT sein.',
    'format.currency': 'Die Währung muss ein gültiger ISO-4217-Code sein.',
    'format.iban_checksum': 'Die IBAN-Prüfsumme (Mod-97) muss gültig sein.',
    'format.monetary_precision':
      'Gedruckte Geldbeträge dürfen höchstens zwei Nachkommastellen haben.',
    'format.vat_id_checksum': 'Die Prüfziffer der USt-IdNr. muss gültig sein.',
    'format.vat_id_syntax':
      'Die USt-IdNr. muss ein zweistelliges Länderpräfix und eine Kennung enthalten.',
    'format.vat_id_prefix':
      'Die USt-IdNr. muss mit einem zulässigen Länderpräfix beginnen.',
    'format.country_code':
      'Der Ländercode muss ein bekannter ISO-3166-1-Code sein.',
    'format.postal_code_de':
      'Bei Land „DE“ muss die Postleitzahl aus 5 Ziffern bestehen.',
    'format.email': 'Die E-Mail-Adresse muss ein gültiges Format haben.',
    'format.phone': 'Die Telefonnummer muss ein gültiges Format haben.',
    'format.bic': 'Die BIC muss 8 oder 11 Zeichen haben.',
    'format.leitweg_id_checksum':
      'Die Prüfziffer der Leitweg-ID muss gültig sein.',
    'mandatory.invoice_number': 'Die Rechnungsnummer muss angegeben sein.',
    'mandatory.issue_date': 'Das Rechnungsdatum muss angegeben sein.',
    'mandatory.currency': 'Die Währung muss angegeben sein.',
    'mandatory.buyer_identity':
      'Name, Postleitzahl, Ort und Land des Käufers müssen angegeben sein.',
    'mandatory.buyer_reference':
      'Die Käuferreferenz (Leitweg-ID) muss angegeben sein.',
    'mandatory.electronic_address':
      'Elektronische Adresse und Adressschema müssen für beide Parteien angegeben sein.',
    'mandatory.line_amounts': 'Jede Position muss einen Nettobetrag haben.',
    'mandatory.line_descriptions':
      'Jede Position muss eine Bezeichnung und eine Menge haben.',
    'mandatory.line_vat_rate_or_exemption':
      'Jede Position muss einen USt-Satz oder einen Befreiungsgrund haben.',
    'mandatory.monetary_total':
      'Nettosumme, Umsatzsteuergesamtbetrag und Rechnungsendbetrag müssen angegeben sein.',
    'mandatory.payment_terms':
      'Zahlungsbedingungen oder ein Fälligkeitsdatum müssen angegeben sein, wenn ein Betrag fällig ist.',
    'mandatory.seller_contact':
      'Ansprechpartner, Telefon und E-Mail des Verkäufers müssen angegeben sein.',
    'mandatory.seller_identity':
      'Name, Postleitzahl, Ort und Land des Verkäufers müssen angegeben sein.',
    'mandatory.seller_tax_id':
      'USt-IdNr. oder Steuernummer des Verkäufers müssen angegeben sein.',
    'mandatory.vat_breakdown':
      'Für jeden USt-Satz muss eine Bemessungsgrundlage angegeben sein.',
    'mandatory.vat_category':
      'Die Steuerkategorie muss zum USt-Satz passen — 0 % benötigt eine Kategorie, jede andere Kategorie als Regelbesteuerung benötigt 0 %.',
    'mandatory.vat_category_buyer_identity':
      'Bei Reverse-Charge und innergemeinschaftlicher Lieferung muss die USt-IdNr. des Käufers angegeben sein.',
    'mandatory.vat_category_reason':
      'Bei der Kategorie „Steuerbefreit (§ 4 UStG)" muss ein Befreiungsgrund angegeben sein.',
    'mandatory.vat_category_seller_vat_id':
      'Bei innergemeinschaftlicher Lieferung muss die USt-IdNr. des Verkäufers angegeben sein.',
    'mandatory.vat_rate_or_exemption':
      'USt-Satz und -Betrag oder ein Befreiungsgrund müssen angegeben sein.',
    'mandatory.delivery_date': 'Das Leistungsdatum sollte angegeben sein.',
    'mandatory.party_street':
      'Die Straße sollte für beide Parteien angegeben sein.',
    'mandatory.seller_iban': 'Die IBAN des Verkäufers sollte angegeben sein.',
    'plausible.line_count':
      'Die Rechnung muss mindestens eine Position enthalten.',
    'plausible.date_order':
      'Das Leistungsdatum sollte nicht nach dem Rechnungsdatum liegen.',
    'plausible.date_range':
      'Das Rechnungsdatum sollte innerhalb eines plausiblen Zeitraums liegen.',
    'plausible.magnitude':
      'Der Rechnungsendbetrag sollte unter 10.000.000 € liegen.',
    'plausible.positive_amounts': 'Beträge sollten nicht negativ sein.',
    'plausible.vat_rate': 'Der USt-Satz sollte 19, 7 oder 0 % betragen.',
    'plausible.zero_vat_reason':
      'Bei einem USt-Satz von 0 % sollte ein Befreiungsgrund angegeben sein.',
    'mapping.amount_precision':
      'Ein Geldbetrag hat mehr als zwei Nachkommastellen und kann nicht abgebildet werden.',
    'mapping.currency': 'Die Währung gehört nicht zur unterstützten Codeliste.',
    'mapping.electronic_address':
      'Die elektronische Adresse fehlt oder kann nicht abgebildet werden.',
    'mapping.electronic_address_scheme':
      'Das Schema der elektronischen Adresse gehört nicht zur unterstützten Codeliste.',
    'mapping.generation_failed':
      'Die XML-Erzeugung ist unerwartet fehlgeschlagen.',
    'mapping.invoice_header':
      'Angaben im Rechnungskopf können nicht abgebildet werden.',
    'mapping.line_item': 'Eine Rechnungsposition kann nicht abgebildet werden.',
    'mapping.line_unit':
      'Die Mengeneinheit einer Position ist nicht in der Einheitentabelle hinterlegt.',
    'mapping.line_vat_category':
      'Der USt-Satz einer Position kann keiner Steuerkategorie zugeordnet werden.',
    'mapping.party_address':
      'Die Adresse einer Partei kann nicht abgebildet werden.',
    'mapping.party_country_code':
      'Der Ländercode einer Partei gehört nicht zur unterstützten Codeliste.',
    'mapping.schema':
      'Die gespeicherten Daten erfüllen nicht das erwartete Schema.',
    'mapping.seller_tax_id':
      'Der Verkäufer hat nur eine Steuernummer angegeben; eine USt-IdNr. ist erforderlich.',
    'mapping.vat_breakdown':
      'Die Umsatzsteueraufschlüsselung kann nicht abgebildet werden.',
    'mapping.vat_breakdown_category':
      'Ein USt-Satz in der Aufschlüsselung kann keiner Steuerkategorie zugeordnet werden.',
    'schema.extracted_data':
      'Die gespeicherten extrahierten Daten erfüllen nicht das erwartete Schema.',
    'kosit.unspecified':
      'Der KoSIT-Validator hat das Dokument abgelehnt, ohne eine Regel zu nennen.',
  } satisfies Record<ValidationRuleCode, string> &
    Record<'kosit.unspecified', string>,
  issues: {
    decimal:
      'Bitte einen Punkt als Dezimaltrennzeichen und kein Tausendertrennzeichen verwenden — zum Beispiel 1234.56.',
    date: 'Bitte ein gültiges Datum wählen.',
    currency:
      'Der Währungscode besteht aus drei Großbuchstaben — zum Beispiel EUR.',
    countryCode:
      'Der Ländercode besteht aus zwei Großbuchstaben — zum Beispiel DE.',
    position: 'Die Positionsnummer muss eine ganze Zahl größer als 0 sein.',
    thousandsSeparator: (value: string) =>
      `Ist „${value}“ als ${value.replace('.', '')} gemeint? Der Punkt zählt hier als Dezimaltrennzeichen.`,
    ibanChecksum: 'Die IBAN-Prüfsumme stimmt nicht — bitte die IBAN prüfen.',
    vatIdSyntax:
      'Die USt-IdNr. muss ein zweistelliges Länderpräfix und eine Kennung enthalten.',
    vatIdPrefix:
      'Die USt-IdNr. muss mit einem zulässigen Länderpräfix beginnen.',
    vatIdChecksum:
      'Die Prüfziffer der USt-IdNr. stimmt nicht — bitte die USt-IdNr. prüfen.',
    germanPostalCode: 'Eine deutsche Postleitzahl hat fünf Ziffern.',
    emailFormat: 'Das sieht nicht wie eine gültige E-Mail-Adresse aus.',
    phoneFormat:
      'Das sieht nicht wie eine gültige Telefonnummer aus — nur Ziffern, „+“, Leerzeichen, Klammern und Bindestriche sind erlaubt.',
    bicFormat: 'Das sieht nicht wie eine gültige BIC aus — 8 oder 11 Zeichen.',
    leitwegIdChecksum:
      'Die Prüfziffer der Leitweg-ID stimmt nicht — bitte die Leitweg-ID prüfen.',
    vatCategory:
      'Die gewählte USt-Kategorie passt nicht zum USt-Satz: Standardsteuer braucht einen positiven Satz, alle anderen Kategorien 0 %.',
    vatCategoryBuyerVatId:
      'Für Reverse-Charge und innergemeinschaftliche Lieferungen ist eine USt-IdNr. des Käufers erforderlich.',
    vatCategorySellerVatId:
      'Für innergemeinschaftliche Lieferungen ist eine USt-IdNr. des Verkäufers erforderlich.',
    schemaMismatch:
      'Dieser Wert kann nicht gesendet werden — bitte den Eintrag prüfen.',
  },
  errors: {
    notFound: 'Diese Rechnung ist nicht mehr verfügbar.',
    conflict: 'Der Status hat sich geändert — die Ansicht wird aktualisiert.',
    unauthorized: 'Die Sitzung ist abgelaufen. Bitte die Seite neu laden.',
    payloadTooLarge: 'Die Datei ist zu groß.',
    rateLimited: (seconds: number, budget: string) =>
      `${budget} Bitte in ${seconds} Sekunden erneut versuchen.`,
    budget: {
      upload: 'Das Kontingent für Uploads ist ausgeschöpft.',
      review: 'Zu viele Korrekturen in kurzer Zeit.',
      retry: 'Zu viele Wiederholungsversuche in kurzer Zeit.',
      polling: 'Zu viele Anfragen.',
    },
    badRequest: 'Die Anfrage wurde abgelehnt.',
    serverError: 'Serverfehler. Bitte später erneut versuchen.',
    networkError: 'Keine Verbindung zum Server.',
    parseError: 'Unerwartete Antwort vom Server.',
    genericTitle: 'Etwas ist schiefgelaufen',
    genericBody: 'Bitte erneut versuchen.',
  },
};
