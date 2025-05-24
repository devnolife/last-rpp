import { Injectable } from '@nestjs/common';
import { LessonDto, BahanAjarDto, QuestionsDto, KisiKisiDto } from './dto';
import {
  EducationRppResponse,
  EducationBahanAjarResponse,
  EducationQuestionsResponse,
  EducationKisiKisiResponse
} from './models';
import * as dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

@Injectable()
export class EducationService {
  private readonly GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  private readonly GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
  private readonly MAX_RETRIES = 3;

  private async generateContent(systemPrompt: string, userPrompt: string, schemaExample: any = null): Promise<string> {
    let retries = 0;
    let result: string;

    while (retries < this.MAX_RETRIES) {
      try {
        // Enhance the system prompt with schema example if provided
        let enhancedSystemPrompt = systemPrompt;
        if (schemaExample) {
          enhancedSystemPrompt += "\n\nHere's an example of the EXACT JSON structure expected:\n" +
            JSON.stringify(schemaExample, null, 2) +
            "\n\nYour response MUST follow this exact structure. Fields can be different but the structure must be identical.";
        }

        // Add a clear instruction about JSON format
        enhancedSystemPrompt += "\n\nIMPORTANT: Your response MUST be valid JSON without any markdown formatting, comments, or explanations. DO NOT wrap the JSON in code blocks.";

        // Combine system and user prompts
        const fullPrompt = enhancedSystemPrompt + "\n\n" + userPrompt;

        const response = await fetch(`${this.GEMINI_API_URL}?key=${this.GEMINI_API_KEY}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: fullPrompt
                  }
                ]
              }
            ],
            generationConfig: {
              temperature: 0.7,
              topK: 40,
              topP: 0.95,
              maxOutputTokens: 8192,
            }
          }),
        });

        const data = await response.json() as {
          candidates?: Array<{
            content: {
              parts: Array<{
                text: string
              }>
            }
          }>
        };

        if (!data.candidates || data.candidates.length === 0) {
          throw new Error('Failed to generate content: No response from API');
        }

        result = data.candidates[0].content.parts[0].text;

        // Clean the response to ensure proper JSON formatting
        const cleanedResult = result
          .replace(/```json\s*/g, '')
          .replace(/```\s*/g, '')
          .trim();

        // Validate JSON structure
        const parsedResult = JSON.parse(cleanedResult);

        // If we have a schema example, validate the structure matches
        if (schemaExample && !this.validateStructure(parsedResult, schemaExample)) {
          throw new Error('Response structure does not match expected schema');
        }

        return cleanedResult;
      } catch (error) {
        console.error(`Error attempt ${retries + 1}/${this.MAX_RETRIES}:`, error);
        retries++;

        // If we've exhausted retries, throw the error
        if (retries >= this.MAX_RETRIES) {
          throw new Error(`Failed to generate valid content after ${this.MAX_RETRIES} attempts: ${error.message}`);
        }

        // Otherwise wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retries)));
      }
    }
  }

  // Helper method to validate that the response structure matches the expected schema
  private validateStructure(response: any, schema: any, path: string = ''): boolean {
    // If schema is null or undefined, any response is valid
    if (schema === null || schema === undefined) {
      return true;
    }

    // If types don't match, structure is invalid
    if (typeof response !== typeof schema) {
      console.error(`Structure mismatch at ${path}: expected ${typeof schema}, got ${typeof response}`);
      return false;
    }

    // If it's an array, check that elements match
    if (Array.isArray(schema)) {
      if (!Array.isArray(response)) {
        console.error(`Structure mismatch at ${path}: expected array, got ${typeof response}`);
        return false;
      }

      // If schema array has an example element, validate first response element against it
      // Only validate if both schema and response have elements
      if (schema.length > 0 && response.length > 0) {
        return this.validateStructure(response[0], schema[0], `${path}[0]`);
      }

      return true;
    }

    // If it's an object, check that properties match
    if (typeof schema === 'object') {
      if (typeof response !== 'object' || response === null) {
        console.error(`Structure mismatch at ${path}: expected object, got ${typeof response}`);
        return false;
      }

      // For questions validation specifically, handle potential variations in structure
      if (path === 'questions' || path.startsWith('questions.')) {
        // Check that all required top-level keys exist in questions object
        if (path === 'questions') {
          const requiredKeys = ['pilihan_ganda', 'menjodohkan', 'benar_salah', 'essay'];
          for (const key of requiredKeys) {
            if (!(key in response)) {
              console.error(`Structure mismatch at ${path}: missing required key ${key}`);
              return false;
            }
          }

          // Validate pilihan_ganda is an array
          if (!Array.isArray(response.pilihan_ganda)) {
            console.error(`Structure mismatch at ${path}.pilihan_ganda: expected array`);
            return false;
          }

          // Validate benar_salah is an array
          if (!Array.isArray(response.benar_salah)) {
            console.error(`Structure mismatch at ${path}.benar_salah: expected array`);
            return false;
          }

          // Validate essay is an array
          if (!Array.isArray(response.essay)) {
            console.error(`Structure mismatch at ${path}.essay: expected array`);
            return false;
          }

          // Validate menjodohkan is an object
          if (typeof response.menjodohkan !== 'object' || response.menjodohkan === null) {
            console.error(`Structure mismatch at ${path}.menjodohkan: expected object`);
            return false;
          }
        }

        return true;
      }

      // For other regular schema validation, check all schema keys exist in response
      for (const key of Object.keys(schema)) {
        if (!(key in response)) {
          console.error(`Structure mismatch at ${path}: missing key ${key}`);
          return false;
        }

        // Recursively validate nested structures
        if (!this.validateStructure(response[key], schema[key], path ? `${path}.${key}` : key)) {
          return false;
        }
      }

      return true;
    }

    // For primitive types, structure is valid
    return true;
  }

  // Helper method to parse allocation time and calculate time distribution
  private parseTimeAllocation(alokasiWaktu: string): { total: number, awal: number, inti: number, akhir: number, sesi: number, menitPerSesi: number } {
    try {
      // Parse format like "2x45 menit", "3x40 menit", "90 menit", etc.
      let totalMinutes = 0;
      let sessions = 1;
      let minutesPerSession = 0;

      // Remove extra spaces and convert to lowercase
      const cleanInput = alokasiWaktu.toLowerCase().trim();

      // Check for format "NxM menit" 
      const multiplyMatch = cleanInput.match(/(\d+)\s*x\s*(\d+)\s*menit/);
      if (multiplyMatch) {
        sessions = parseInt(multiplyMatch[1]);
        minutesPerSession = parseInt(multiplyMatch[2]);
        totalMinutes = sessions * minutesPerSession;
      }
      // Check for format "N menit"
      else {
        const directMatch = cleanInput.match(/(\d+)\s*menit/);
        if (directMatch) {
          totalMinutes = parseInt(directMatch[1]);
          minutesPerSession = totalMinutes;
        }
      }

      // Default to 90 minutes if parsing fails
      if (totalMinutes <= 0) {
        totalMinutes = 90;
        minutesPerSession = 90;
      }

      // Calculate time distribution per session
      const waktuAkhir = Math.round(minutesPerSession * 0.1); // 10% of session time for closing
      const waktuAwal = Math.round(minutesPerSession * 0.15); // 15% of session time for opening
      const waktuInti = minutesPerSession - waktuAwal - waktuAkhir; // Remaining time for core activities

      return {
        total: totalMinutes,
        awal: waktuAwal,
        inti: waktuInti,
        akhir: waktuAkhir,
        sesi: sessions,
        menitPerSesi: minutesPerSession
      };
    } catch (error) {
      // Default allocation if parsing fails
      return {
        total: 90,
        awal: 15,
        inti: 65,
        akhir: 10,
        sesi: 1,
        menitPerSesi: 90
      };
    }
  }

  async generateLesson(data: LessonDto): Promise<EducationRppResponse> {
    try {
      // Check for required fields (mata_pelajaran, jenjang, kelas)
      if (!data.mata_pelajaran || !data.jenjang || !data.kelas) {
        throw new Error('Required fields missing: mata_pelajaran, jenjang, and kelas are mandatory');
      }

      // Calculate dynamic time allocation
      const alokasiWaktuInput = data.alokasi_waktu || '2x45 menit';
      const timeAllocation = this.parseTimeAllocation(alokasiWaktuInput);

      // Fill in missing fields with AI-generated content if not provided
      const autoGeneratePrompt = `
      Berdasarkan informasi bahwa ini adalah mata pelajaran ${data.mata_pelajaran} untuk jenjang ${data.jenjang} kelas ${data.kelas},
      berikan rekomendasi untuk komponen RPP berikut:
      ${!data.alokasi_waktu ? '- alokasi_waktu (format pertemuan x menit)' : ''}
      ${!data.tahapan ? '- tahapan pembelajaran' : ''}
      ${!data.capaian_pembelajaran ? '- capaian pembelajaran sesuai kurikulum terbaru' : ''}
      ${!data.domain_konten ? '- domain konten/elemen' : ''}
      ${!data.tujuan_pembelajaran ? '- tujuan pembelajaran (minimal 3-5 tujuan)' : ''}
      ${!data.konten_utama ? '- konten utama pembelajaran' : ''}
      ${!data.prasyarat ? '- prasyarat pengetahuan/keterampilan' : ''}
      ${!data.pemahaman_bermakna ? '- pemahaman bermakna' : ''}
      ${!data.profil_pelajar ? '- profil pelajar pancasila yang relevan' : ''}
      ${!data.sarana ? '- sarana dan prasarana yang diperlukan' : ''}
      ${!data.target_peserta ? '- target peserta didik' : ''}
      ${!data.jumlah_peserta ? '- perkiraan jumlah peserta didik' : ''}
      ${!data.model_pembelajaran ? '- model pembelajaran yang sesuai' : ''}
      ${!data.sumber_belajar ? '- sumber belajar yang direkomendasikan' : ''}
      `;

      // Only call the AI if there are missing fields
      let autoGeneratedFields = {};
      if (autoGeneratePrompt.includes('-')) {
        const systemPrompt = `
        Kamu adalah asisten AI spesialis pendidikan dengan pengalaman mendalam dalam kurikulum Indonesia.
        Berikan rekomendasi untuk komponen RPP yang tidak disediakan oleh pengguna.
        Berikan jawaban dalam format JSON dengan struktur:
        {
          "alokasi_waktu": "string", // contoh: "2x45 menit"
          "tahapan": "string",
          "capaian_pembelajaran": "string",
          "domain_konten": "string",
          "tujuan_pembelajaran": "string",
          "konten_utama": "string",
          "prasyarat": "string",
          "pemahaman_bermakna": "string",
          "profil_pelajar": "string",
          "sarana": "string",
          "target_peserta": "string", 
          "jumlah_peserta": "string",
          "model_pembelajaran": "string",
          "sumber_belajar": "string"
        }
        Sertakan HANYA field yang diminta.
        `;

        const autoGenResult = await this.generateContent(systemPrompt, autoGeneratePrompt);
        autoGeneratedFields = JSON.parse(autoGenResult);
      }

      // Merge user-provided data with auto-generated fields
      const completeData = {
        ...data,
        ...autoGeneratedFields
      };

      // Schema example for RPP
      const schemaExample = {
        "identitas": {
          "nama_penyusun": "Sample Name",
          "institusi": "Sample Institution",
          "tahun_pembuatan": "2023/2024",
          "mata_pelajaran": "Sample Subject",
          "jenjang": "Sample Level",
          "kelas": "Sample Class",
          "alokasi_waktu": "2x45 menit",
          "tahapan": "Sample Stage"
        },
        "komponen_pembelajaran": {
          "capaian_pembelajaran": "Sample learning outcomes",
          "domain_konten": "Sample content domain",
          "tujuan_pembelajaran": ["Sample goal 1", "Sample goal 2"],
          "konten_utama": "Sample main content",
          "prasyarat_pengetahuan": "Sample prerequisites",
          "pemahaman_bermakna": "Sample meaningful understanding",
          "profil_pelajar_pancasila": ["Dimension 1", "Dimension 2"],
          "sarana_prasarana": ["Item 1", "Item 2"],
          "target_peserta_didik": "Sample target",
          "jumlah_peserta_didik": "30-35",
          "model_pembelajaran": "Sample learning model",
          "sumber_belajar": ["Source 1", "Source 2"]
        },
        "kegiatan_pembelajaran": {
          "kegiatan_awal": [
            { "aktivitas": "Sample activity 1", "durasi": "5 menit", "deskripsi": "Sample description" },
            { "aktivitas": "Sample activity 2", "durasi": "5 menit", "deskripsi": "Sample description" }
          ],
          "kegiatan_inti": [
            { "aktivitas": "Sample activity 1", "durasi": "15 menit", "deskripsi": "Sample description" },
            { "aktivitas": "Sample activity 2", "durasi": "15 menit", "deskripsi": "Sample description" }
          ],
          "kegiatan_penutup": [
            { "aktivitas": "Sample activity 1", "durasi": "5 menit", "deskripsi": "Sample description" },
            { "aktivitas": "Sample activity 2", "durasi": "5 menit", "deskripsi": "Sample description" }
          ]
        },
        "materi_assessment": {
          "bahan_ajar": {
            "teori": "Sample theory content",
            "materi_linguistik": "Sample linguistic material",
            "teks": "Sample text content",
            "materi_visual": "Sample visual material"
          },
          "remedial": {
            "aktivitas": ["Activity 1", "Activity 2"],
            "strategi": "Sample remedial strategy",
            "instrumen": "Sample remedial instrument"
          },
          "pengayaan": {
            "aktivitas": ["Activity 1", "Activity 2", "Activity 3"],
            "produk": "Sample expected output"
          },
          "assessment": {
            "rubrik_pengetahuan": {
              "teknik": "Sample technique",
              "bentuk": "Sample form",
              "kisi_kisi": "Sample blueprint",
              "instrumen": ["Question 1", "Question 2", "Question 3", "Question 4", "Question 5"]
            },
            "rubrik_keterampilan": [
              {
                "aspek": "Sample aspect",
                "deskripsi": [
                  { "level": "Level 1", "deskripsi": "Sample description", "skor": 5 },
                  { "level": "Level 2", "deskripsi": "Sample description", "skor": 4 }
                ]
              }
            ]
          }
        }
      };

      const systemPrompt = `
      Kamu adalah asisten AI spesialis pendidikan dengan keahlian dalam menyusun Rencana Pelaksanaan Pembelajaran (RPP) sesuai Kurikulum Merdeka.
      Buatlah RPP yang mengikuti format dan pendekatan Kurikulum Merdeka dengan prinsip pembelajaran yang berpusat pada peserta didik.
      
      Format RPP Kurikulum Merdeka harus mencakup:
      
      1. IDENTITAS - Informasi dasar (satuan pendidikan, mata pelajaran, kelas, alokasi waktu, tahun ajaran)
      
      2. CAPAIAN PEMBELAJARAN (CP) DAN TUJUAN PEMBELAJARAN:
         - Capaian Pembelajaran sesuai fase yang relevan
         - Elemen/Sub-elemen yang akan dicapai
         - Tujuan pembelajaran yang spesifik, terukur, dan bermakna
         - Kata kerja operasional yang sesuai dengan level kognitif peserta didik
      
      3. PROFIL PELAJAR PANCASILA:
         - Dimensi profil pelajar pancasila yang dikembangkan dalam pembelajaran
         - Elemen dan sub-elemen yang relevan dengan materi
      
      4. PEMAHAMAN BERMAKNA:
         - Pertanyaan pemantik yang memancing rasa ingin tahu
         - Konteks kehidupan nyata yang relevan dengan peserta didik
      
      5. KEGIATAN PEMBELAJARAN:
         Alokasi waktu total: ${timeAllocation.total} menit (${timeAllocation.sesi} sesi x ${timeAllocation.menitPerSesi} menit)
         
         Untuk setiap sesi pembelajaran (${timeAllocation.menitPerSesi} menit):
         
         A. Kegiatan Pembuka (${timeAllocation.awal} menit):
            * Minimal 5-7 aktivitas TERSTRUKTUR dengan estimasi waktu per aktivitas
            * Harus mencakup: salam pembuka, doa, cek kehadiran, apersepsi, motivasi, penyampaian tujuan pembelajaran, pre-test/review
            * Berikan pertanyaan spesifik yang digunakan untuk memancing pengetahuan awal siswa
            * Jelaskan bagaimana guru mengaitkan materi dengan kehidupan sehari-hari
            * PENTING: Total waktu semua aktivitas harus TEPAT ${timeAllocation.awal} menit
         
         B. Kegiatan Inti (${timeAllocation.inti} menit):
            * Eksplorasi, elaborasi, konfirmasi dengan pendekatan student-centered
            * Evaluasi akhir setiap individu
            * Pembagian aktivitas yang jelas dengan durasi spesifik
            * PENTING: Total waktu semua aktivitas harus TEPAT ${timeAllocation.inti} menit
         
         C. Kegiatan Penutup (${timeAllocation.akhir} menit):
            * Minimal 5 aktivitas DETAIL dengan durasi spesifik
            * Harus mencakup: refleksi, kesimpulan, post-test/evaluasi, umpan balik, penyampaian materi selanjutnya, penugasan, dan salam penutup
            * Berikan contoh SPESIFIK pertanyaan refleksi
            * Jelaskan bagaimana guru menilai pencapaian tujuan pembelajaran
            * PENTING: Total waktu semua aktivitas harus TEPAT ${timeAllocation.akhir} menit
         
         CATATAN PENTING:
         - Jika pembelajaran terdiri dari ${timeAllocation.sesi} sesi, buat pembagian materi dan aktivitas yang berkesinambungan antar sesi
         - Setiap sesi harus memiliki target pencapaian yang jelas
         - Pastikan ada pengaitan materi antara sesi sebelumnya dengan sesi selanjutnya
         - Total waktu per sesi harus TEPAT ${timeAllocation.menitPerSesi} menit
      
      6. ASESMEN:
         - Asesmen diagnostik (untuk mengetahui kondisi awal peserta didik)
         - Asesmen formatif (selama proses pembelajaran)
         - Asesmen sumatif (di akhir pembelajaran)
         - RUBRIK PENILAIAN LENGKAP dengan kriteria yang jelas
      
      7. DIFERENSIASI PEMBELAJARAN:
         - Diferensiasi konten, proses, dan produk
         - Strategi untuk mengakomodasi keberagaman peserta didik
      
      8. REMEDIAL DAN PENGAYAAN:
         - Program remedial untuk peserta didik yang belum mencapai tujuan
         - Program pengayaan untuk peserta didik yang sudah mencapai tujuan
      
      Pastikan RPP menggunakan pendekatan:
      - Pembelajaran berbasis proyek/masalah sesuai konteks
      - Kolaboratif dan interaktif
      - Mengembangkan kemampuan berpikir tingkat tinggi (HOTS)
      - Mengintegrasikan teknologi jika relevan
      - Memberikan ruang untuk voice dan choice peserta didik
      
      Output dalam format JSON. Gunakan terminologi Kurikulum Merdeka yang tepat dan sesuai dengan karakteristik pembelajaran abad 21.
      `;

      const userPrompt = `
      Buatlah RPP Kurikulum Merdeka yang lengkap berdasarkan informasi berikut:

      Mata Pelajaran: ${completeData.mata_pelajaran}
      Jenjang: ${completeData.jenjang}
      Kelas/Fase: ${completeData.kelas}
      Alokasi Waktu: ${completeData.alokasi_waktu || '2x45 menit'} (Total: ${timeAllocation.total} menit)
      ${completeData.capaian_pembelajaran ? `Capaian Pembelajaran: ${completeData.capaian_pembelajaran}` : ''}
      ${completeData.tujuan_pembelajaran ? `Tujuan Pembelajaran: ${completeData.tujuan_pembelajaran}` : ''}
      ${completeData.konten_utama ? `Konten/Materi: ${completeData.konten_utama}` : ''}
      ${completeData.model_pembelajaran ? `Model Pembelajaran: ${completeData.model_pembelajaran}` : ''}
      ${completeData.catatan ? `Catatan Tambahan: ${completeData.catatan}` : ''}

      Hasilkan RPP Kurikulum Merdeka yang mencakup:
      1. Identitas pembelajaran (satuan pendidikan, mata pelajaran, fase/kelas, alokasi waktu)
      2. Capaian Pembelajaran dan elemen yang akan dicapai
      3. Tujuan pembelajaran yang bermakna dan terukur
      4. Profil Pelajar Pancasila yang dikembangkan
      5. Pemahaman bermakna dan pertanyaan pemantik
      6. Kegiatan pembelajaran student-centered:
         - Kegiatan Pembuka: ${timeAllocation.awal} menit
         - Kegiatan Inti: ${timeAllocation.inti} menit
         - Kegiatan Penutup: ${timeAllocation.akhir} menit
      7. Asesmen (diagnostik, formatif, sumatif) dengan rubrik penilaian lengkap
      8. Diferensiasi pembelajaran (konten, proses, produk)
      9. Program remedial dan pengayaan

      Buatlah RPP yang mengutamakan pembelajaran bermakna, kontekstual, dan sesuai dengan prinsip Kurikulum Merdeka.
      `;

      const result = await this.generateContent(systemPrompt, userPrompt, schemaExample);

      // Parse the string result into a JSON object
      const parsedResult = JSON.parse(result);

      return {
        status: 'success',
        message: `RPP for ${data.mata_pelajaran} generated successfully`,
        rpp: parsedResult
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message
      };
    }
  }

  async generateBahanAjar(data: BahanAjarDto): Promise<EducationBahanAjarResponse> {
    try {
      // Check for required fields (mata_pelajaran, kelas, materi)
      if (!data.mata_pelajaran || !data.kelas || !data.materi) {
        throw new Error('Required fields missing: mata_pelajaran, kelas, and materi are mandatory');
      }

      // Schema example for Bahan Ajar
      const schemaExample = {
        "bahan_ajar": {
          "judul": "Sample Title",
          "deskripsi": "Sample Description",
          "materi": {
            "penjelasan": "Sample explanation",
            "istilah_penting": [
              { "istilah": "Term 1", "penjelasan": "Explanation 1" },
              { "istilah": "Term 2", "penjelasan": "Explanation 2" }
            ]
          },
          "contoh": [
            "Sample example 1",
            "Sample example 2"
          ],
          "latihan": {
            "pemahaman": ["Question 1", "Question 2"],
            "penerapan": ["Question 1", "Question 2"],
            "analisis": ["Question 1", "Question 2"],
            "evaluasi": ["Question 1", "Question 2"]
          },
          "kunci_jawaban": {
            "latihan_1": ["Answer 1", "Answer 2"],
            "latihan_2": ["Answer 1", "Answer 2"]
          }
        }
      };

      const systemPrompt = `
      Kamu adalah seorang ahli pengembangan bahan ajar untuk pendidikan. 
      Buatlah bahan ajar yang komprehensif, interaktif, dan sesuai dengan standar pendidikan Indonesia.
      
      Format output bahan ajar harus mengikuti struktur berikut:
      - Penjelasan konsep yang jelas
      - Daftar istilah penting dengan penjelasan
      - Contoh dialog atau teks yang menggunakan istilah tersebut
      - Latihan (pemahaman, penerapan, analisis, evaluasi)
      - Kunci jawaban
      
      Berikan output dalam format JSON yang terstruktur dan lengkap seperti berikut:
      
      {
        "bahan_ajar": {
          "judul": "string",
          "deskripsi": "string",
          "materi": {
            "penjelasan": "string",
            "istilah_penting": [
              {"istilah": "string", "penjelasan": "string"},
              {"istilah": "string", "penjelasan": "string"}
            ]
          },
          "contoh": [
            "string (dialog/teks)",
            "string"
          ],
          "latihan": {
            "pemahaman": ["string", "string"],
            "penerapan": ["string", "string"],
            "analisis": ["string", "string"],
            "evaluasi": ["string", "string"]
          },
          "kunci_jawaban": {
            "latihan_1": ["string", "string"],
            "latihan_2": ["string", "string"]
          }
        }
      }
      `;

      const userPrompt = `
      Anda adalah asisten AI spesialis pendidikan.
      Buatkan bahan ajar yang lengkap dan sesuai dengan:

      Mata Pelajaran: ${data.mata_pelajaran}
      Kelas: ${data.kelas}
      Materi: ${data.materi}

      Hasilkan bahan ajar yang lengkap dengan komponen:
      1. Materi lengkap (teori, konsep, dan penjelasan)
      2. Daftar istilah penting beserta penjelasannya (minimal 10 istilah)
      3. Contoh-contoh yang menggunakan istilah-istilah tersebut
      4. Latihan-latihan (exercises) untuk berbagai tingkat kemampuan
      5. Kunci jawaban

      Buatkan dalam format yang menarik, jelas, dan sesuai untuk peserta didik pada kelas tersebut.
      `;

      const result = await this.generateContent(systemPrompt, userPrompt, schemaExample);

      // Parse the string result into a JSON object
      const parsedResult = JSON.parse(result);

      return {
        status: 'success',
        message: `Bahan Ajar for ${data.mata_pelajaran} generated successfully`,
        bahan_ajar: parsedResult
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message
      };
    }
  }

  async generateQuestions(data: QuestionsDto): Promise<EducationQuestionsResponse> {
    try {
      // Check for required fields (mata_pelajaran, kelas, materi)
      if (!data.mata_pelajaran || !data.kelas || !data.materi) {
        throw new Error('Required fields missing: mata_pelajaran, kelas, and materi are mandatory');
      }

      // Schema example for Questions
      const schemaExample = {
        "questions": {
          "pilihan_ganda": [
            {
              "paragraf": "Sample paragraph",
              "pertanyaan": "Sample question",
              "opsi": ["A. Option 1", "B. Option 2", "C. Option 3", "D. Option 4"],
              "jawaban_benar": "A. Option 1"
            }
          ],
          "menjodohkan": {
            "instruksi": "Sample instructions",
            "kolom_a": ["Item 1", "Item 2", "Item 3", "Item 4", "Item 5"],
            "kolom_b": ["Match 1", "Match 2", "Match 3", "Match 4", "Match 5"],
            "jawaban": { "Item 1": "Match 3", "Item 2": "Match 1", "Item 3": "Match 5", "Item 4": "Match 2", "Item 5": "Match 4" }
          },
          "benar_salah": [
            {
              "pernyataan": "Sample statement 1",
              "jawaban": true,
              "referensi_paragraf": 1
            }
          ],
          "essay": [
            {
              "pertanyaan": "Sample essay question 1",
              "panduan_jawaban": "Sample answer guide",
              "referensi_paragraf": 1
            }
          ]
        }
      };

      const systemPrompt = `
      Kamu adalah seorang ahli dalam membuat soal dan penilaian untuk siswa di Indonesia.
      Buatlah soal yang berkualitas, kontekstual, dan sesuai dengan materi pembelajaran.
      
      Soal yang dibuat harus mencakup 4 jenis yang SALING TERHUBUNG dalam tema dan materi:
      
      1. PILIHAN GANDA - Buatlah 5 soal pilihan ganda dengan 4 opsi jawaban (A, B, C, D)
         - Setiap soal pilihan ganda harus memiliki paragraf narasi atau teks (minimal 5-7 kalimat)
         - Paragraf harus terkait dengan konten materi dan menjadi dasar pertanyaan
         - Total harus ada 5 paragraf (satu untuk setiap soal) yang saling berkaitan dalam tema
         - Pertanyaan harus langsung berkaitan dengan isi paragraf dan menguji pemahaman siswa
      
      2. MENJODOHKAN - Buatlah 5 soal menjodohkan
         - Konten menjodohkan harus BERKAITAN dengan isi paragraf pada soal pilihan ganda
         - Konsep yang diuji harus sama dengan yang ada di paragraf
      
      3. BENAR-SALAH - Buatlah 5 pernyataan benar/salah
         - Pernyataan harus LANGSUNG mengacu pada informasi dalam paragraf di soal pilihan ganda
         - Gunakan informasi spesifik dari paragraf untuk membuat pernyataan
      
      4. ESSAY - Buatlah 2 soal essay/uraian
         - Soal essay harus meminta siswa menganalisis, mensintesis, atau mengevaluasi informasi dari paragraf
         - Harus menggunakan konteks yang SAMA dengan paragraf dalam soal pilihan ganda
      
      KETERKAITAN ANTAR SOAL:
      - Pastikan semua jenis soal membahas tema/topik yang SAMA
      - Gunakan kosakata, konsep, dan konteks yang konsisten di semua soal
      - Soal benar-salah dan essay harus mengacu pada informasi dari paragraf di soal pilihan ganda
      - Menciptakan pengalaman tes yang kohesif dan terintegrasi
      
      OUTPUT HARUS DALAM FORMAT JSON SEPERTI INI:
      {
        "questions": {
          "pilihan_ganda": [
            {
              "paragraf": "Teks paragraf 1",
              "pertanyaan": "Pertanyaan 1",
              "opsi": ["A. Pilihan 1", "B. Pilihan 2", "C. Pilihan 3", "D. Pilihan 4"],
              "jawaban_benar": "A. Pilihan 1"
            },
            ... 4 soal lainnya dengan struktur yang sama ...
          ],
          "menjodohkan": {
            "instruksi": "Petunjuk menjodohkan",
            "kolom_a": ["Item 1", "Item 2", "Item 3", "Item 4", "Item 5"],
            "kolom_b": ["Match 1", "Match 2", "Match 3", "Match 4", "Match 5"],
            "jawaban": { 
              "Item 1": "Match 3", 
              "Item 2": "Match 1", 
              "Item 3": "Match 5", 
              "Item 4": "Match 2", 
              "Item 5": "Match 4" 
            }
          },
          "benar_salah": [
            {
              "pernyataan": "Pernyataan 1",
              "jawaban": true,
              "referensi_paragraf": 1
            },
            ... 4 pernyataan lainnya dengan struktur yang sama ...
          ],
          "essay": [
            {
              "pertanyaan": "Pertanyaan essay 1",
              "panduan_jawaban": "Panduan jawaban 1",
              "referensi_paragraf": 1
            },
            {
              "pertanyaan": "Pertanyaan essay 2",
              "panduan_jawaban": "Panduan jawaban 2",
              "referensi_paragraf": 2
            }
          ]
        }
      }
      
      PERHATIAN PENTING:
      1. Respons HARUS dalam bentuk JSON murni tanpa kode markdown atau teks di luar JSON
      2. Struktur JSON HARUS tepat seperti contoh di atas
      3. Semua kunci (keys) dalam JSON harus sama persis dengan contoh
      4. Nilai harus sesuai dengan tipe data yang diharapkan
      5. Pastikan format JSON valid dan dapat di-parse
      `;

      const userPrompt = `
      Buatlah soal evaluasi yang sesuai dengan informasi berikut:

      Mata Pelajaran: ${data.mata_pelajaran}
      Kelas: ${data.kelas}
      Materi: ${data.materi}
      Jumlah Soal: ${data.jumlah || '10'}
      
      Hasilkan 4 jenis soal yang SALING TERHUBUNG dalam tema yang SAMA:
      
      1. PILIHAN GANDA (5 soal) - Setiap soal harus memiliki:
         - Paragraf yang langsung mengacu pada materi (5-7 kalimat)
         - Pertanyaan yang langsung berkaitan dengan isi paragraf
         - 4 pilihan jawaban (A, B, C, D)
      
      2. MENJODOHKAN (5 soal)
         - Berhubungan dengan tema/konten dalam paragraf pilihan ganda
      
      3. BENAR-SALAH (5 soal)
         - Pernyataan yang LANGSUNG mengacu pada informasi dalam paragraf pilihan ganda
         - Jelaskan paragraf mana yang menjadi acuan setiap pernyataan
      
      4. ESSAY (2 soal)
         - Pertanyaan yang meminta analisis atau penerapan informasi dari paragraf
         - Jelaskan paragraf mana yang menjadi acuan setiap pertanyaan essay
      
      PERHATIKAN:
      - Pastikan ada keterkaitan yang jelas antara paragraf, pertanyaan pilihan ganda, soal menjodohkan, 
        pernyataan benar-salah, dan pertanyaan essay
      - Soal benar-salah dan essay harus jelas menunjukkan paragraf mana yang menjadi referensinya
      - Buat soal yang kohesif dan terintegrasi, bukan soal-soal yang berdiri sendiri
      `;

      const result = await this.generateContent(systemPrompt, userPrompt, schemaExample);

      // Parse the string result into a JSON object
      const parsedResult = JSON.parse(result);

      return {
        status: 'success',
        message: `Questions for ${data.mata_pelajaran} generated successfully`,
        questions: parsedResult
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message
      };
    }
  }

  async generateKisiKisi(data: KisiKisiDto): Promise<EducationKisiKisiResponse> {
    try {
      // Check for required fields (mata_pelajaran, kelas, materi)
      if (!data.mata_pelajaran || !data.kelas || !data.materi) {
        throw new Error('Required fields missing: mata_pelajaran, kelas, and materi are mandatory');
      }

      // Schema example for Kisi-Kisi
      const schemaExample = {
        "kisi_kisi": {
          "identitas": {
            "mata_pelajaran": "Sample Subject",
            "kelas": "Sample Class",
            "materi": "Sample Material"
          },
          "tabel_kisi_kisi": [
            {
              "nomor": 1,
              "tujuan_pembelajaran": "Sample learning objective",
              "materi": "Sample material",
              "indikator_soal": "Sample indicator",
              "level_kognitif": "C1-Mengingat",
              "bentuk_soal": "Pilihan Ganda",
              "nomor_soal": "1"
            }
          ]
        }
      };

      const systemPrompt = `
      Kamu adalah ahli penilaian pendidikan yang menguasai pembuatan kisi-kisi soal untuk sekolah di Indonesia.
      Tugasmu adalah menghasilkan kisi-kisi penulisan soal (blueprint) untuk asesmen berdasarkan materi pembelajaran.
      
      Kisi-kisi ini HARUS mengikuti format sesuai kurikulum merdeka dan mencakup tabel dengan kolom:
      1. Nomor (1, 2, 3, dst)
      2. Tujuan Pembelajaran 
      3. Materi
      4. Indikator Soal (deskripsikan apa yang diuji oleh soal tersebut)
      5. Level Kognitif (C1-Mengingat, C2-Memahami, C3-Menerapkan, C4-Menganalisis, C5-Mengevaluasi, C6-Mencipta)
      6. Bentuk Soal (Pilihan Ganda, Menjodohkan, Benar-Salah, Essay)
      7. Nomor Soal
      
      PENTING! Kisi-kisi harus mencakup semua jenis soal yang ada (pilihan ganda, menjodohkan, benar-salah, dan essay).
      Level kognitif harus bervariasi dan sesuai dengan jenis pertanyaan/soal.
      
      Berikan output dalam format JSON yang terstruktur.
      `;

      const userPrompt = `
      Buatlah kisi-kisi penulisan soal untuk asesmen berdasarkan data berikut:
      
      Mata Pelajaran: ${data.mata_pelajaran}
      Kelas: ${data.kelas}
      Materi: ${data.materi}
      
      Buatlah kisi-kisi yang memuat informasi dan tabel kisi-kisi sesuai format yang diminta.
      Pastikan setiap jenis soal (pilihan ganda, menjodohkan, benar-salah, essay) memiliki entri dalam tabel kisi-kisi 
      dan level kognitif bervariasi sesuai dengan jenis soal.
      
      Gunakan format JSON yang terstruktur dan lengkap.
      `;

      const result = await this.generateContent(systemPrompt, userPrompt, schemaExample);

      // Parse the string result into a JSON object
      const parsedResult = JSON.parse(result);

      return {
        status: 'success',
        message: `Kisi-kisi for ${data.mata_pelajaran} generated successfully`,
        kisi_kisi: parsedResult
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message
      };
    }
  }
} 
